"use strict";
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const yaml = require('js-yaml');
const { digest, regularFile, VERSION } = require('./release-artifacts.cjs');
const { publicUrl } = require('./release-config.cjs');
const TARGETS = ['mac/x64','mac/arm64','win/x64','win/arm64'];
async function assemble({ input, output, notes = '' }) {
  input = path.resolve(input); output = path.resolve(output);
  if (input === output || output.startsWith(input + path.sep)) throw new Error('Keep bundle output separate from staged inputs.');
  if (notes.length > 2000) throw new Error('Release notes must be at most 2000 characters.');
  const stages = (await fs.readdir(input, { withFileTypes: true })).filter(item => item.isDirectory() && !item.isSymbolicLink());
  const releases = [];
  for (const entry of stages) {
    const dir = path.join(input,entry.name), evidencePath = path.join(dir,'release-evidence.json');
    if ((await regularFile(evidencePath)).size > 65536) throw new Error('Oversized release evidence.');
    releases.push({ dir, value: JSON.parse(await fs.readFile(evidencePath,'utf8')) });
  }
  const first = releases[0]?.value;
  if (releases.length !== 4 || !VERSION.test(first?.version) || !/^[a-f0-9]{40}$/.test(first?.sourceSha) || new Set(releases.map(item => item.value.platform + '/' + item.value.arch)).size !== 4) throw new Error('Exactly four independently verified platform/architecture builds are required.');
  const base = publicUrl(first.distributionUrl), downloads = [], copies = [];
  for (const { dir, value } of releases) {
    const key = value.platform + '/' + value.arch;
    if (!TARGETS.includes(key) || value.schemaVersion !== 1 || value.version !== first.version || value.sourceSha !== first.sourceSha || publicUrl(value.distributionUrl) !== base || !Array.isArray(value.files) || !value.files.length || value.files.length > 4 || value.downloads?.length !== 1) throw new Error('Release evidence does not describe one consistent source, version and distribution.');
    const expectedKind = value.platform === 'mac' ? 'signed-and-notarized' : 'signed';
    const download = value.downloads[0];
    if (download.platform !== value.platform || download.arch !== value.arch || download.verification !== expectedKind || !value.identity || !Number.isFinite(Date.parse(value.verifiedAt))) throw new Error('Missing native signature evidence.');
    const root = `releases/${value.version}/${key}/`;
    for (const file of value.files) {
      const extension = value.platform === 'mac' ? /\.(?:dmg|zip)(?:\.blockmap)?$/ : /\.exe(?:\.blockmap)?$/;
      if (typeof file.name !== 'string' || path.basename(file.name) !== file.name || file.name.includes('\\') || !file.name.startsWith(`Sapiovian Classroom-${value.version}-${value.platform}-${value.arch}.`) || !extension.test(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Unsafe or unexpected release file.');
      const source = path.join(dir,file.name), stat = await regularFile(source);
      if (stat.size !== file.bytes || await digest(source) !== file.sha256 || await digest(source,'sha512','base64') !== file.sha512) throw new Error('Staged artifact bytes changed after native verification.');
      copies.push({ source, relative: root + file.name, sha256: file.sha256 });
    }
    const record = value.files.find(file => file.name === download.name);
    if (!record || record.sha256 !== download.sha256 || record.bytes !== download.bytes || download.url !== base + root + encodeURIComponent(download.name)) throw new Error('Download metadata does not match the verified installer.');
    downloads.push(download);
    const feedName = value.platform === 'mac' ? 'latest-mac.yml' : 'latest.yml';
    if (value.feed !== feedName) throw new Error('Unexpected platform update metadata.');
    const feedPath = path.join(dir,feedName); if ((await regularFile(feedPath)).size > 131072) throw new Error('Oversized feed.');
    const feedBytes = await fs.readFile(feedPath,'utf8');
    const feed = yaml.load(feedBytes, { schema: yaml.JSON_SCHEMA });
    const artifacts = value.files.filter(file => !file.name.endsWith('.blockmap'));
    if (feed?.version !== value.version || !Array.isArray(feed.files) || feed.files.length !== artifacts.length || new Set(feed.files.map(file => file.url)).size !== artifacts.length) throw new Error('Incomplete update feed.');
    for (const item of feed.files) {
      const file = artifacts.find(file => base + root + encodeURIComponent(file.name) === item.url);
      if (!file || file.sha512 !== item.sha512 || file.bytes !== item.size) throw new Error('Update feed hash or destination does not match the release.');
    }
    if (!feed.files.some(file => file.url === feed.path && file.sha512 === feed.sha512)) throw new Error('Legacy update feed fields are inconsistent.');
    copies.push({ source: feedPath, relative: `stable/${key}/${feedName}`, sha256: createHash('sha256').update(feedBytes).digest('hex') });
  }
  await fs.mkdir(output,{ recursive:true }); if ((await fs.readdir(output)).length) throw new Error('Assemble into an empty directory.');
  for (const copy of copies) { const dest = path.join(output,copy.relative); await fs.mkdir(path.dirname(dest),{recursive:true}); await fs.copyFile(copy.source,dest); if (await digest(dest) !== copy.sha256) throw new Error('Release bytes changed during bundle assembly.'); }
  const catalogue = { schemaVersion:1, available:true, version:first.version, sourceSha:first.sourceSha, publishedAt:new Date().toISOString(), notes, downloads:downloads.sort((a,b)=>(a.platform+a.arch).localeCompare(b.platform+b.arch)) };
  await fs.writeFile(path.join(output,'desktop-release.json'),JSON.stringify(catalogue,null,2)+'\n');
  const files = [];
  for (const relative of [...copies.map(item=>item.relative),'desktop-release.json'].sort()) files.push({ path:relative,sha256:await digest(path.join(output,relative)) });
  await fs.writeFile(path.join(output,'bundle-index.json'),JSON.stringify({schemaVersion:1,version:first.version,sourceSha:first.sourceSha,files},null,2)+'\n');
  return catalogue;
}
function compareVersions(a,b) { if (!VERSION.test(a) || !VERSION.test(b)) throw new Error('Invalid release version.'); const left=a.split('.').map(Number),right=b.split('.').map(Number);for(let i=0;i<3;i++) if(left[i]!==right[i])return left[i]>right[i]?1:-1;return 0; }
async function publish({ bundle, destination }) {
  bundle = path.resolve(bundle); destination = path.resolve(destination);
  if (bundle === destination || destination.startsWith(bundle + path.sep)) throw new Error('Publish to a separate web root.');
  const indexPath=path.join(bundle,'bundle-index.json');if((await regularFile(indexPath)).size>65536)throw new Error('Oversized bundle index.');
  const index=JSON.parse(await fs.readFile(indexPath,'utf8'));
  if(index.schemaVersion!==1 || !VERSION.test(index.version) || !/^[a-f0-9]{40}$/.test(index.sourceSha) || !Array.isArray(index.files) || index.files.length<11 || index.files.length>24)throw new Error('Invalid release bundle index.');
  const allowed=new Set(['desktop-release.json',...TARGETS.map(target=>'stable/'+target+'/'+(target.startsWith('mac/')?'latest-mac.yml':'latest.yml'))]);
  const seen=new Set();
  for(const file of index.files){
    if(typeof file.path!=='string'||file.path.includes('\\')||file.path.split('/').some(part=>!part||part==='.'||part==='..')||(!allowed.has(file.path)&&!file.path.startsWith('releases/'+index.version+'/'))||seen.has(file.path)||!/^[a-f0-9]{64}$/.test(file.sha256))throw new Error('Unsafe bundle path.');
    seen.add(file.path);await regularFile(path.join(bundle,file.path));if(await digest(path.join(bundle,file.path))!==file.sha256)throw new Error('Bundle bytes do not match the reviewed index.');
  }
  if([...allowed].some(name=>!seen.has(name)))throw new Error('Bundle is missing catalogue or platform feeds.');
  const catalogue=JSON.parse(await fs.readFile(path.join(bundle,'desktop-release.json'),'utf8'));
  if(catalogue.version!==index.version||catalogue.sourceSha!==index.sourceSha||catalogue.downloads?.length!==4)throw new Error('Bundle catalogue mismatch.');
  await fs.mkdir(destination,{recursive:true}); if((await fs.lstat(destination)).isSymbolicLink())throw new Error('Publish to a real directory.');
  const lockPath=path.join(destination,'.desktop-publication.lock');
  let lock;try{lock=await fs.open(lockPath,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw new Error('The publication directory is locked. Inspect the current publisher before removing a stale lock.');throw error;}await lock.close();
  try {
  try{const old=JSON.parse(await fs.readFile(path.join(destination,'desktop-release.json'),'utf8'));if(compareVersions(index.version,old.version)<0 || (index.version===old.version && old.sourceSha!==index.sourceSha))throw new Error('Refusing to replace a newer or different release.');}catch(error){if(error.code!=='ENOENT')throw error;}
  // Install immutable bytes first. Publish each platform pointer atomically, then the catalogue.
  const ordered=[...index.files.filter(file=>file.path.startsWith('releases/')),...index.files.filter(file=>file.path.startsWith('stable/')),index.files.find(file=>file.path==='desktop-release.json')];
  for(const file of ordered){const pieces=file.path.split('/'),name=pieces.pop();let dir=destination;for(const part of pieces){dir=path.join(dir,part);await fs.mkdir(dir,{recursive:true});const stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('A publication directory is unsafe.');}const dest=path.join(dir,name);
    try{const stat=await fs.lstat(dest);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('A publication file is unsafe.');if(file.path.startsWith('releases/')){if(await digest(dest)!==file.sha256)throw new Error('An immutable artifact already exists with different bytes.');continue;}}catch(error){if(error.code!=='ENOENT')throw error;}
    const temp=path.join(dir,'.desktop-'+randomUUID());try{await fs.copyFile(path.join(bundle,file.path),temp);if(await digest(temp)!==file.sha256)throw new Error('Release bytes changed during publication.');await fs.rename(temp,dest);}finally{await fs.rm(temp,{force:true});}
  }
  return catalogue;
  } finally { await fs.unlink(lockPath); }
}
module.exports={assemble,publish,compareVersions};
if(require.main===module)(async()=>{const [command,input,output]=process.argv.slice(2);if(!input||!output)throw new Error('Use assemble STAGES BUNDLE or publish BUNDLE WEB_ROOT.');if(command==='assemble')await assemble({input,output,notes:process.env.SFU_DESKTOP_RELEASE_NOTES??''});else if(command==='publish')await publish({bundle:input,destination:output});else throw new Error('Choose assemble or publish.');process.stdout.write('Desktop release '+command+' completed.\n');})().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
