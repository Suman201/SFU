'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const {execFile}=require('node:child_process');const {promisify}=require('node:util');const {randomUUID}=require('node:crypto');const run=promisify(execFile);
test('desktop hosting serves exact bytes, range requests and uncached update pointers without SPA fallbacks',{timeout:120000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sfu-desktop-host-')),name='sfu-desktop-test-'+randomUUID().slice(0,8),image='nginx:1.27-alpine';
  t.after(async()=>{await run('docker',['rm','-f',name]).catch(()=>undefined);await fs.rm(root,{recursive:true,force:true});});
  await fs.chmod(root,0o755);
  const directory=path.join(root,'releases/0.2.0/win/x64');await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'fixture.exe'),'0123456789');await fs.mkdir(path.join(root,'stable/win/x64'),{recursive:true});await fs.writeFile(path.join(root,'stable/win/x64/latest.yml'),'version: 0.2.0\n');await fs.writeFile(path.join(root,'desktop-release.json'),'{}');
  await run('docker',['run','--detach','--name',name,'--label','com.sapiovian.test-suite=desktop-distribution','--publish','127.0.0.1::80','--volume',path.resolve('apps/frontend/nginx.conf')+':/etc/nginx/conf.d/default.conf:ro','--volume',root+':/srv/desktop-distribution:ro',image]);
  const endpoint=(await run('docker',['port',name,'80/tcp'])).stdout.trim(),origin='http://'+endpoint;let connected=false;
  for(let i=0;i<50;i++){try{const r=await fetch(origin+'/desktop-downloads/stable/win/x64/latest.yml');if(r.status===200){connected=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.equal(connected,true);
  await run('docker',['exec',name,'nginx','-t']);
  const url=origin+'/desktop-downloads/releases/0.2.0/win/x64/fixture.exe',full=await fetch(url);assert.equal(full.status,200);assert.equal(await full.text(),'0123456789');assert.match(full.headers.get('cache-control'),/immutable/);assert.equal(full.headers.get('x-content-type-options'),'nosniff');
  const head=await fetch(url,{method:'HEAD'});assert.equal(head.headers.get('content-length'),'10');assert.equal(await head.text(),'');
  const range=await fetch(url,{headers:{range:'bytes=3-5'}});assert.equal(range.status,206);assert.equal(await range.text(),'345');assert.equal(range.headers.get('content-range'),'bytes 3-5/10');
  const feed=await fetch(origin+'/desktop-downloads/stable/win/x64/latest.yml');assert.equal(feed.status,200);assert.equal(feed.headers.get('cache-control'),'no-store');
  const absent=await fetch(origin+'/desktop-downloads/releases/no-such-file.exe');assert.equal(absent.status,404);assert.doesNotMatch(absent.headers.get('cache-control')??'',/immutable/);
  assert.equal((await fetch(origin+'/desktop-downloads/bundle-index.json')).status,404);
  assert.equal((await fetch(origin+'/desktop-downloads/desktop-release.json')).status,404);
});
