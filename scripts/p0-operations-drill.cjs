#!/usr/bin/env node
'use strict';
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, appendFileSync, chmodSync } = require('node:fs');
const { createHash, randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const tag = 'p0-' + randomBytes(5).toString('hex');
const label = 'com.sapiovian.p0-drill';
const work = mkdtempSync(path.join(os.tmpdir(), tag + '-'));
const alertWork = mkdtempSync(path.join(os.tmpdir(), tag + '-alerts-'));
chmodSync(alertWork, 0o755);
const hostUser = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
const containers = [];
let network;
const report = { generatedAt: new Date().toISOString(), environment: 'isolated-synthetic-local', productionSignoff: false, checks: {} };
function docker(args, timeout = 120000) { if (args[0] === 'exec' && !args.includes('mongosh')) args = ['exec', '--user', hostUser, '--env', 'HOME=/tmp', ...args.slice(1)]; return execFileSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function start(name, args) { docker(['run', '-d', '--name', name, '--label', `${label}=${tag}`, ...args]); containers.push(name); }
async function until(check, what, timeout = 90000) { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await check()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 500)); } throw Error('Timed out: ' + what); }
function mongo(name, script) { return docker(['exec', name, 'mongosh', '--quiet', '--eval', script]); }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function backupEnv(assets) { return ['RECORDING_LOCAL_PATH','CHAT_ATTACHMENT_LOCAL_PATH','CLASS_MATERIAL_LOCAL_PATH','PROFILE_MEDIA_LOCAL_PATH','TUTOR_INTRO_VIDEO_LOCAL_PATH','TUTOR_VERIFICATION_LOCAL_PATH'].flatMap((key, i) => ['-e', `${key}=/drill/${assets}/asset-${i}`]); }
async function backupRestore() {
  const source = tag + '-source', target = tag + '-restore';
  const image = 'native-sfu-p0-operations:local';
  docker(['build', '--tag', image, path.join(root, 'tests/operations')], 300000);
  const mount = ['--mount', `type=bind,src=${work},dst=/drill`, '--mount', `type=bind,src=${path.join(root, 'scripts')},dst=/sfu-scripts,readonly`];
  start(source, [...mount, image]); start(target, [...mount, image]);
  await until(() => mongo(source, 'db.adminCommand({ping:1}).ok') === '1' && mongo(target, 'db.adminCommand({ping:1}).ok') === '1', 'isolated MongoDB');
  const docs = [{ _id: 'lesson-1', title: 'Synthetic restore lesson', amountMinor: 10000, currency: 'USD' }, { _id: 'lesson-2', title: 'Private Q&A fixture', owner: 'synthetic-student' }];
  mongo(source, `db=db.getSiblingDB('p0_restore_drill');db.evidence.insertMany(${JSON.stringify(docs)});db.createCollection('empty_collection');db.evidence.createIndex({owner:1});`);
  const key = randomBytes(32), iv = randomBytes(12), plain = Buffer.from('Synthetic verification evidence; no personal data.');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const files = [];
  for (let i = 0; i < 6; i++) {
    const dir = path.join(work, 'source', 'asset-' + i); mkdirSync(dir, { recursive: true });
    const bytes = i === 5 ? Buffer.concat([iv, authTag, encrypted]) : Buffer.from('synthetic asset ' + i);
    writeFileSync(path.join(dir, 'evidence.bin'), bytes); files.push(bytes);
  }
  mkdirSync(path.join(work, 'keys'), { mode: 0o700 });
  docker(['exec', source, 'age-keygen', '-o', '/drill/keys/identity.txt']);
  const recipient = docker(['exec', source, 'age-keygen', '-y', '/drill/keys/identity.txt']);
  if (!recipient.startsWith('age1')) throw Error('No backup encryption recipient generated.');
  const began = Date.now();
  docker(['exec', '-e', 'MONGODB_URI=mongodb://127.0.0.1:27017/p0_restore_drill', '-e', 'BACKUP_ROOT=/drill/backups', '-e', `BACKUP_AGE_RECIPIENT=${recipient}`, '-e', 'BACKUP_RETENTION_DAYS=30', ...backupEnv('source'), source, 'bash', '/sfu-scripts/backup-production.sh']);
  const bundle = readdirSync(path.join(work, 'backups')).find(name => name.endsWith('.tar.gz.age'));
  if (!bundle) throw Error('Production backup script produced no archive.');
  const backedUpAt = Date.now();
  docker(['exec', '-e', 'MONGODB_URI=mongodb://127.0.0.1:27017/p0_restore_drill', '-e', 'RESTORE_CONFIRMATION=restore-production-data', '-e', `BACKUP_BUNDLE=/drill/backups/${bundle}`, '-e', 'BACKUP_AGE_IDENTITY_FILE=/drill/keys/identity.txt', ...backupEnv('restored'), target, 'bash', '/sfu-scripts/restore-production.sh']);
  const restoredAt = Date.now();
  const restored = JSON.parse(mongo(target, "JSON.stringify(db.getSiblingDB('p0_restore_drill').evidence.find().sort({_id:1}).toArray())"));
  if (JSON.stringify(restored) !== JSON.stringify(docs)) throw Error('Restored MongoDB documents differ.');
  if (mongo(target, "db.getSiblingDB('p0_restore_drill').getCollectionNames().includes('empty_collection')") !== 'true') throw Error('Empty collection lost.');
  if (mongo(target, "db.getSiblingDB('p0_restore_drill').evidence.getIndexes().some(i=>i.name==='owner_1')") !== 'true') throw Error('Index lost.');
  for (let i = 0; i < files.length; i++) if (digest(readFileSync(path.join(work, 'restored', 'asset-' + i, 'evidence.bin'))) !== digest(files[i])) throw Error('Restored asset differs: ' + i);
  const privateBytes = readFileSync(path.join(work, 'restored', 'asset-5/evidence.bin'));
  const decipher = createDecipheriv('aes-256-gcm', key, privateBytes.subarray(0, 12)); decipher.setAuthTag(privateBytes.subarray(12, 28));
  if (!Buffer.concat([decipher.update(privateBytes.subarray(28)), decipher.final()]).equals(plain)) throw Error('Restored private evidence cannot be decrypted with its separately retained key.');
  const corruptDir = path.join(work, 'corrupt'); mkdirSync(corruptDir);
  docker(['exec', source, 'age', '--decrypt', '--identity', '/drill/keys/identity.txt', '--output', '/drill/plain-backup.tar.gz', '/drill/backups/' + bundle]);
  execFileSync('tar', ['-xzf', path.join(work, 'plain-backup.tar.gz'), '-C', corruptDir]);
  appendFileSync(path.join(corruptDir, 'assets/recordings.tar.gz'), 'corruption-test');
  execFileSync('tar', ['-czf', path.join(work, 'backups/corrupt.tar.gz'), '-C', corruptDir, '.']);
  docker(['exec', source, 'age', '--recipient', recipient, '--output', '/drill/backups/corrupt.tar.gz.age', '/drill/backups/corrupt.tar.gz']);
  mongo(target, "db.getSiblingDB('p0_restore_drill').evidence.updateOne({_id:'lesson-1'},{$set:{guard:'must remain'}})");
  docker(['exec', source, 'age-keygen', '-o', '/drill/keys/wrong.txt']);
  let wrongKeyRejected = false;
  try { docker(['exec', '-e', 'MONGODB_URI=mongodb://127.0.0.1:27017/p0_restore_drill', '-e', 'RESTORE_CONFIRMATION=restore-production-data', '-e', `BACKUP_BUNDLE=/drill/backups/${bundle}`, '-e', 'BACKUP_AGE_IDENTITY_FILE=/drill/keys/wrong.txt', ...backupEnv('restored'), target, 'bash', '/sfu-scripts/restore-production.sh']); }
  catch { wrongKeyRejected = true; }
  if (!wrongKeyRejected || mongo(target, "db.getSiblingDB('p0_restore_drill').evidence.findOne({_id:'lesson-1'}).guard") !== 'must remain') throw Error('Wrong decryption key was not rejected before database writes.');
  let rejected = false;
  try { docker(['exec', '-e', 'MONGODB_URI=mongodb://127.0.0.1:27017/p0_restore_drill', '-e', 'RESTORE_CONFIRMATION=restore-production-data', '-e', 'BACKUP_BUNDLE=/drill/backups/corrupt.tar.gz.age', '-e', 'BACKUP_AGE_IDENTITY_FILE=/drill/keys/identity.txt', ...backupEnv('restored'), target, 'bash', '/sfu-scripts/restore-production.sh']); }
  catch (error) { rejected = /FAILED|checksum/i.test(String(error.stdout) + String(error.stderr)); }
  if (!rejected || mongo(target, "db.getSiblingDB('p0_restore_drill').evidence.findOne({_id:'lesson-1'}).guard") !== 'must remain') throw Error('Corrupt archive was not rejected before database writes.');
  report.checks.backupRestore = { passed: true, realProductionScripts: true, databaseDocuments: restored.length, assetDirectories: 6, emptyCollectionAndIndexes: true, privateEvidenceDecryption: true, corruptArchiveRejectedBeforeWrites: true, backupMs: backedUpAt - began, restoreMs: restoredAt - backedUpAt, bundleSha256: digest(readFileSync(path.join(work, 'backups', bundle))), archiveEncryption: 'age', wrongRestoreKeyRejectedBeforeWrites: true, deploymentRpoRto: 'not measured' };
}
async function alertDelivery() {
  docker(['run', '--rm', '--mount', `type=bind,src=${path.join(root, 'infra/prometheus')},dst=/rules,readonly`, '--entrypoint', '/bin/promtool', 'prom/prometheus:v2.55.0', 'check', 'rules', '/rules/alerts.yml']);
  docker(['run', '--rm', '--mount', `type=bind,src=${path.join(root, 'infra/prometheus')},dst=/rules,readonly`, '--mount', `type=bind,src=${path.join(root, 'tests/operations')},dst=/fixtures,readonly`, '--entrypoint', '/bin/promtool', 'prom/prometheus:v2.55.0', 'test', 'rules', '/fixtures/prometheus-alerts.test.yml']);
  network = tag + '-network'; docker(['network', 'create', '--label', `${label}=${tag}`, network]);
  const receiver = tag + '-receiver', alertmanager = tag + '-alerts', secret = randomBytes(18).toString('hex');
  const receiverJs = `const http=require('http');const events=[];http.createServer((req,res)=>{if(req.url==='/events/${secret}'&&req.method==='GET'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(events));}if(req.url!=='/webhook/${secret}'||req.method!=='POST'){res.statusCode=404;return res.end();}let body='';req.on('data',chunk=>{body+=chunk;if(body.length>65536)req.destroy();});req.on('end',()=>{try{events.push(JSON.parse(body));res.statusCode=200;res.end('ok');}catch{res.statusCode=400;res.end();}});}).listen(8080,'0.0.0.0');`;
  writeFileSync(path.join(alertWork, 'receiver.cjs'), receiverJs);
  writeFileSync(path.join(alertWork, 'receiver.url'), `http://${receiver}:8080/webhook/${secret}`);
  const config = readFileSync(path.join(root, 'infra/alertmanager/alertmanager.yml'), 'utf8').replace('group_wait: 30s', 'group_wait: 1s').replace('group_interval: 5m', 'group_interval: 1s').replace('/run/secrets/alertmanager_webhook_url', '/drill/receiver.url');
  if (!config.includes('send_resolved: true')) throw Error('Production receiver configuration must deliver resolved alerts.');
  writeFileSync(path.join(alertWork, 'alertmanager.yml'), config);
  const mount = ['--mount', `type=bind,src=${alertWork},dst=/drill,readonly`];
  start(receiver, ['--network', network, '-p', '127.0.0.1::8080', ...mount, 'node:22-alpine', 'node', '/drill/receiver.cjs']);
  start(alertmanager, ['--network', network, '-p', '127.0.0.1::9093', ...mount, 'prom/alertmanager:v0.28.1', '--config.file=/drill/alertmanager.yml', '--storage.path=/alertmanager', '--cluster.listen-address=']);
  const endpoint = name => 'http://127.0.0.1:' + docker(['port', name, name === receiver ? '8080/tcp' : '9093/tcp']).split(':').pop();
  const sink = endpoint(receiver) + '/events/' + secret, base = endpoint(alertmanager);
  await until(async () => (await fetch(base + '/-/ready', { signal: AbortSignal.timeout(5000) })).ok, 'Alertmanager readiness');
  await until(async () => (await fetch(sink, { signal: AbortSignal.timeout(5000) })).ok, 'isolated alert receiver readiness');
  const alert = { labels: { alertname: 'NativeSfuMediaWorkersUnavailable', severity: 'critical', instance: 'synthetic-p0-drill' }, annotations: { summary: 'Synthetic isolated P0 delivery drill' }, startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 120000).toISOString() };
  const send = async () => { const response = await fetch(base + '/api/v2/alerts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([alert]), signal: AbortSignal.timeout(5000) }); if (!response.ok) throw Error('Alertmanager rejected drill alert: ' + response.status); };
  await send();
  await until(async () => (await (await fetch(sink, { signal: AbortSignal.timeout(5000) })).json()).some(event => event.status === 'firing'), 'firing webhook delivery', 30000);
  alert.endsAt = new Date(Date.now() - 1000).toISOString(); await send();
  await until(async () => (await (await fetch(sink, { signal: AbortSignal.timeout(5000) })).json()).some(event => event.status === 'resolved'), 'resolved webhook delivery', 30000);
  report.checks.alertDelivery = { passed: true, productionRulesParsed: true, productionRuleFireResolveTests: true, actualAlertmanager: true, firing: true, resolved: true, receiver: 'isolated Docker-network sink', productionReceiverDelivery: 'not exercised' };
}
async function main() {
  try { await backupRestore(); await alertDelivery(); report.passed = true; }
  catch (error) { report.passed = false; report.error = error.message; process.exitCode = 1; }
  finally {
    for (const name of containers.reverse()) { try { if (docker(['inspect', '--format', `{{ index .Config.Labels "${label}" }}`, name]) === tag) docker(['rm', '-f', '-v', name]); } catch {} }
    if (network) { try { docker(['network', 'rm', network]); } catch {} }
    rmSync(work, { recursive: true, force: true });
    rmSync(alertWork, { recursive: true, force: true });
    const output = path.resolve(process.env.P0_REPORT_DIR || path.join(root, 'reports/p0')); mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, 'operations.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }
}
main();
