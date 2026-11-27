"use strict";
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const yaml = require('js-yaml');
const { publicUrl, target } = require('./release-config.cjs');
const run = promisify(execFile);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
async function digest(file, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm);
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest(encoding);
}
async function regularFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error('Release artifacts must be nonempty regular files.');
  return stat;
}
async function verifyMacApp(app, teamId, arch) {
  await run('codesign', ['--verify','--deep','--strict', app]);
  const signature = await run('codesign', ['-d','--verbose=4', app]);
  if (!(signature.stderr + signature.stdout).split(/\r?\n/).includes('TeamIdentifier=' + teamId)) throw new Error('The Mac signature does not match the configured team.');
  const executable = path.join(app, 'Contents/MacOS/Sapiovian Classroom');
  if (!(signature.stderr + signature.stdout).split(/\r?\n/).includes('Identifier=com.nativesfu.classroom')) throw new Error('Unexpected Mac application identifier.');
  const architectures = (await run('lipo', ['-archs', executable])).stdout.trim().split(/\s+/);
  if (architectures.length !== 1 || architectures[0] !== (arch === 'x64' ? 'x86_64' : 'arm64')) throw new Error('Incorrect Mac application architecture.');
  await run('xcrun', ['stapler','validate', app]);
  await run('spctl', ['--assess','--type','execute','--verbose=2', app]);
}
async function nativeVerify(file, { platform, arch, teamId, publisher, version }) {
  if (platform === 'mac') {
    if (process.platform !== 'darwin') throw new Error('Verify Mac releases on a Mac runner.');
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sfu-verify-mac-'));
    let mounted = false;
    try {
      if (file.endsWith('.dmg')) {
        await fs.mkdir(path.join(temp, 'volume'));
        await run('hdiutil', ['attach','-readonly','-nobrowse','-mountpoint',path.join(temp,'volume'), file]); mounted = true;
        await verifyMacApp(path.join(temp,'volume','Sapiovian Classroom.app'), teamId, arch);
      } else {
        await run('ditto', ['-x','-k',file,temp]);
        await verifyMacApp(path.join(temp,'Sapiovian Classroom.app'), teamId, arch);
      }
    } finally {
      if (mounted) await run('hdiutil', ['detach',path.join(temp,'volume')]);
      await fs.rm(temp, { recursive: true, force: true });
    }
    return { kind: 'signed-and-notarized', identity: teamId };
  }
  if (process.platform !== 'win32') throw new Error('Verify Windows releases on a Windows runner.');
  // Inputs are transferred through the environment, never interpolated into PowerShell code.
  const script = "$s=Get-AuthenticodeSignature -LiteralPath $env:SFU_VERIFY_FILE; if($s.Status -ne 'Valid' -or -not $s.TimeStamperCertificate){throw 'Invalid or untimestamped Authenticode signature'}; $cn=$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false); if($cn -cne $env:SFU_VERIFY_PUBLISHER){throw 'Unexpected signing publisher'}; $v=[Version](Get-Item -LiteralPath $env:SFU_VERIFY_FILE).VersionInfo.ProductVersion; if(($v.Major.ToString()+'.'+$v.Minor+'.'+$v.Build) -ne $env:SFU_VERIFY_VERSION){throw 'Unexpected binary version'}; [Console]::Write($cn)";
  await run('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], { env: { ...process.env, SFU_VERIFY_FILE: file, SFU_VERIFY_PUBLISHER: publisher, SFU_VERIFY_VERSION: version } });
  return { kind: 'signed', identity: publisher };
}
async function stageRelease(options, verifier = nativeVerify) {
  const { platform, arch } = target(options.platform, options.arch);
  if (!VERSION.test(options.version) || !/^[a-f0-9]{40}$/.test(options.sourceSha)) throw new Error('Use a stable semantic version and an exact source commit.');
  const distributionUrl = publicUrl(options.distributionUrl);
  if (platform === 'mac' ? !/^[A-Z0-9]{10}$/.test(options.teamId ?? '') : !options.publisher?.trim()) throw new Error('An expected signing identity is required.');
  const directory = path.resolve(options.directory), output = path.resolve(options.output);
  if (directory === output || output.startsWith(directory + path.sep)) throw new Error('Keep staged release output separate from builder output.');
  const prefix = `Sapiovian Classroom-${options.version}-${platform}-${arch}`;
  const names = platform === 'mac' ? [prefix + '.dmg',prefix + '.zip'] : [prefix + '.exe'];
  if (platform === 'win') {
    const executable = path.join(directory, arch === 'x64' ? 'win-unpacked' : 'win-arm64-unpacked', 'Sapiovian Classroom.exe');
    await regularFile(executable);
    const file = await fs.open(executable,'r');
    try { const dos = Buffer.alloc(64); await file.read(dos,0,64,0); const offset = dos.readUInt32LE(60); if (dos.toString('ascii',0,2) !== 'MZ' || offset > 1048576) throw new Error('Invalid Windows application header.'); const pe=Buffer.alloc(6);await file.read(pe,0,6,offset);if(pe.readUInt32LE(0)!==0x4550 || pe.readUInt16LE(4)!==(arch==='x64'?0x8664:0xaa64))throw new Error('Incorrect Windows application architecture.'); } finally { await file.close(); }
    const proof = await verifier(executable,options);
    if(proof.kind !== 'signed' || proof.identity !== options.publisher)throw new Error('The Windows application payload is not signed by the expected publisher.');
  }
  const records = [], downloads = [];
  for (const name of names) {
    const file = path.join(directory, name), stat = await regularFile(file);
    const proof = await verifier(file, options);
    if (proof.kind !== (platform === 'mac' ? 'signed-and-notarized' : 'signed') || proof.identity !== (platform === 'mac' ? options.teamId : options.publisher)) throw new Error('Artifact signature evidence is incomplete.');
    const sha256 = await digest(file), sha512 = await digest(file,'sha512','base64');
    records.push({ name, bytes: stat.size, sha256, sha512 });
    const mapName = name + '.blockmap', map = path.join(directory, mapName), mapStat = await regularFile(map);
    records.push({ name: mapName, bytes: mapStat.size, sha256: await digest(map), sha512: await digest(map,'sha512','base64') });
    if (!name.endsWith('.zip')) downloads.push({ platform, arch, name, bytes: stat.size, sha256, verification: proof.kind, url: distributionUrl + `releases/${options.version}/${platform}/${arch}/` + encodeURIComponent(name) });
  }
  const feedName = platform === 'mac' ? 'latest-mac.yml' : 'latest.yml';
  const feedFile = path.join(directory, feedName);
  if ((await regularFile(feedFile)).size > 131072) throw new Error('Update metadata is too large.');
  const info = yaml.load(await fs.readFile(feedFile,'utf8'), { schema: yaml.JSON_SCHEMA });
  if (info?.version !== options.version || !Array.isArray(info.files) || !info.files.length || info.files.length > 8) throw new Error('Update metadata has the wrong version or files.');
  const files = info.files.map(item => {
    if (typeof item.url !== 'string' || /[/\\?#]/.test(item.url)) throw new Error('Update metadata must reference a local release filename.');
    const name = decodeURIComponent(item.url), record = records.find(row => row.name === name && !name.endsWith('.blockmap'));
    if (!record || item.sha512 !== record.sha512 || (item.size !== undefined && item.size !== record.bytes)) throw new Error('Update metadata does not match the verified artifact bytes.');
    return { url: distributionUrl + `releases/${options.version}/${platform}/${arch}/` + encodeURIComponent(name), sha512: record.sha512, size: record.bytes };
  });
  if (files.length !== names.length || new Set(files.map(file => file.url)).size !== names.length) throw new Error('Every installer/archive must appear exactly once in update metadata.');
  const main = records.find(item => item.name === decodeURIComponent(String(info.path)));
  if (!main || info.sha512 !== main.sha512) throw new Error('Legacy update metadata has an incorrect hash.');
  const feed = { version: options.version, files, path: files.find(file => file.sha512 === main.sha512).url, sha512: main.sha512, releaseDate: new Date().toISOString() };
  await fs.mkdir(output, { recursive: true });
  if ((await fs.readdir(output)).length) throw new Error('Stage into an empty output directory.');
  for (const file of records) await fs.copyFile(path.join(directory,file.name),path.join(output,file.name));
  await fs.writeFile(path.join(output,feedName), yaml.dump(feed, { noRefs: true, lineWidth: -1 }));
  const evidence = { schemaVersion: 1, version: options.version, sourceSha: options.sourceSha, platform, arch, distributionUrl, verifiedAt: new Date().toISOString(), identity: platform === 'mac' ? options.teamId : options.publisher, files: records, downloads, feed: feedName };
  await fs.writeFile(path.join(output,'release-evidence.json'), JSON.stringify(evidence,null,2) + '\n');
  await fs.writeFile(path.join(output,'SHA256SUMS'), records.map(file => file.sha256 + '  ' + file.name).join('\n') + '\n');
  return evidence;
}
module.exports = { stageRelease, digest, regularFile, VERSION };
if (require.main === module) (async () => {
  const { releaseConfiguration } = require('./release-config.cjs'), config = releaseConfiguration(process.env, { credentials: false });
  const pkg = require('../package.json');
  await stageRelease({ ...config, version: pkg.version, sourceSha: process.env.SFU_DESKTOP_SOURCE_SHA, directory: process.argv[2], output: process.argv[3] });
  process.stdout.write('Desktop artifacts passed native signature, architecture, notarization and update hash checks.\n');
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
