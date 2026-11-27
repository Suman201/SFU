"use strict";
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {createHash}=require('node:crypto');const yaml=require('js-yaml');
const {releaseConfiguration,publicUrl}=require('../scripts/release-config.cjs');const {buildConfiguration}=require('../scripts/build-configuration.cjs');const {stageRelease}=require('../scripts/release-artifacts.cjs');const {assemble,publish}=require('../scripts/release-bundle.cjs');
const sha='a'.repeat(40),base='https://downloads.school.edu/classroom/';
const common={SFU_DESKTOP_RELEASE:'true',SFU_DESKTOP_SERVER_URL:'https://api.school.edu',SFU_DESKTOP_WEBSITE_URL:'https://school.edu',SFU_DESKTOP_ADMIN_URL:'https://admin.school.edu',SFU_DESKTOP_DISTRIBUTION_URL:base,SFU_DESKTOP_TARGET_PLATFORM:'mac',SFU_DESKTOP_TARGET_ARCH:'x64',APPLE_TEAM_ID:'AB12345678'};
test('production signing preflight rejects missing credentials and unsafe deployment URLs',()=>{
  assert.throws(()=>releaseConfiguration(common),/CSC_LINK/);
  for(const value of ['http://downloads.school.edu','https://user:secret@downloads.school.edu','https://localhost/','https://127.0.0.1/','https://downloads.example.com/','https://downloads.school.edu/?token=secret','https://downloads.school.edu/#fragment'])assert.throws(()=>publicUrl(value));
  assert.throws(()=>releaseConfiguration({...common,SFU_DESKTOP_UPDATE_URL:base+'stable/mac/arm64/'},{credentials:false}),/architecture/);
  assert.equal(releaseConfiguration(common,{credentials:false}).updateUrl,base+'stable/mac/x64/');
});
test('production packaging enforces signing, notarization and exact runtime destinations',()=>{
  const env={...common,CSC_LINK:'synthetic-certificate',CSC_KEY_PASSWORD:'synthetic-only',APPLE_API_KEY:'/tmp/synthetic.p8',APPLE_API_KEY_ID:'key',APPLE_API_ISSUER:'issuer'};
  const release=releaseConfiguration(env);const runtime={serverUrl:release.serverUrl,websiteUrl:release.websiteUrl,updateUrl:release.updateUrl};
  const config=buildConfiguration({appId:'com.nativesfu.classroom',mac:{hardenedRuntime:true},win:{}},runtime,env);
  assert.equal(config.forceCodeSigning,true);assert.equal(config.mac.notarize,true);assert.equal(config.win.verifyUpdateCodeSignature,true);
  assert.throws(()=>buildConfiguration({}, {...runtime,serverUrl:'https://other.school.edu'},env),/runtime/);
  const win={...common,SFU_DESKTOP_TARGET_PLATFORM:'win',SFU_DESKTOP_WIN_PUBLISHER:'School Publisher',SFU_DESKTOP_AZURE_ENDPOINT:'https://eus.codesigning.azure.net/',SFU_DESKTOP_AZURE_ACCOUNT:'school-signing',SFU_DESKTOP_AZURE_PROFILE:'public-profile'};
  assert.equal(releaseConfiguration(win,{credentials:false}).azureSignOptions.publisherName,'School Publisher');assert.throws(()=>releaseConfiguration(win),/AZURE_CLIENT/);
});
async function artifactFixture(root,platform,arch,version='0.2.0'){
  const directory=path.join(root,platform+'-'+arch),output=path.join(root,'stages',platform+'-'+arch);await fs.mkdir(directory,{recursive:true});
  const names=[`Sapiovian Classroom-${version}-${platform}-${arch}.`+(platform==='mac'?'dmg':'exe')];if(platform==='mac')names.push(`Sapiovian Classroom-${version}-${platform}-${arch}.zip`);
  const files=[];for(const name of names){const bytes=Buffer.from('Synthetic fixture only: '+name);await fs.writeFile(path.join(directory,name),bytes);await fs.writeFile(path.join(directory,name+'.blockmap'),'synthetic-blockmap');files.push({url:name,sha512:createHash('sha512').update(bytes).digest('base64'),size:bytes.length});}
  if(platform==='win'){const dir=path.join(directory,arch==='x64'?'win-unpacked':'win-arm64-unpacked');await fs.mkdir(dir);const bytes=Buffer.alloc(160);bytes.write('MZ');bytes.writeUInt32LE(100,60);bytes.writeUInt32LE(0x4550,100);bytes.writeUInt16LE(arch==='x64'?0x8664:0xaa64,104);await fs.writeFile(path.join(dir,'Sapiovian Classroom.exe'),bytes);}
  const feed=platform==='mac'?'latest-mac.yml':'latest.yml';await fs.writeFile(path.join(directory,feed),yaml.dump({version,files,path:files[0].url,sha512:files[0].sha512}));
  return{directory,output,platform,arch,version,sourceSha:sha,distributionUrl:base,teamId:'AB12345678',publisher:'School Publisher'};
}
const proof=async(_file,options)=>({kind:options.platform==='mac'?'signed-and-notarized':'signed',identity:options.platform==='mac'?options.teamId:options.publisher});
test('unsigned or unnotarized artifacts cannot enter the signed release stage',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sfu-release-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const options=await artifactFixture(root,'mac','x64');await assert.rejects(stageRelease(options,async()=>({kind:'unsigned',identity:''})),/signature/);assert.equal(await fs.stat(options.output).then(()=>true,()=>false),false);
});
test('staging rejects mismatched update hashes, substituted files and wrong Windows architecture',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sfu-release-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const options=await artifactFixture(root,'mac','x64');await fs.appendFile(path.join(options.directory,`Sapiovian Classroom-0.2.0-mac-x64.zip`),'changed');await assert.rejects(stageRelease(options,proof),/metadata/);
  const win=await artifactFixture(root,'win','arm64');const app=path.join(win.directory,'win-arm64-unpacked','Sapiovian Classroom.exe');const bytes=await fs.readFile(app);bytes.writeUInt16LE(0x8664,104);await fs.writeFile(app,bytes);await assert.rejects(stageRelease(win,proof),/architecture/);
});
test('four verified targets assemble and publish atomically without replacing immutable files or newer releases',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sfu-release-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const options=[];for(const platform of ['mac','win'])for(const arch of ['x64','arm64']){const item=await artifactFixture(root,platform,arch);options.push(item);await stageRelease(item,proof);}
  const stages=path.join(root,'stages'),bundle=path.join(root,'bundle');
  const catalogue=await assemble({input:stages,output:bundle,notes:'Synthetic acceptance release only.'});assert.equal(catalogue.downloads.length,4);
  for(const file of catalogue.downloads)assert.match(file.url,/\/releases\/0\.2\.0\/(mac|win)\/(x64|arm64)\//);
  const destination=path.join(root,'public');await fs.mkdir(destination);await fs.writeFile(path.join(destination,'.desktop-publication.lock'),'');await assert.rejects(publish({bundle,destination}),/locked/);await fs.unlink(path.join(destination,'.desktop-publication.lock'));await publish({bundle,destination});await publish({bundle,destination});
  const live=JSON.parse(await fs.readFile(path.join(destination,'desktop-release.json'),'utf8'));assert.equal(live.version,'0.2.0');
  const feeds=await fs.readFile(path.join(destination,'stable/mac/arm64/latest-mac.yml'),'utf8');assert.match(feeds,/releases\/0\.2\.0\/mac\/arm64\//);
  await fs.writeFile(path.join(destination,'desktop-release.json'),JSON.stringify({...live,version:'0.3.0'}));await assert.rejects(publish({bundle,destination}),/newer/);
  await fs.appendFile(path.join(options[0].output,`Sapiovian Classroom-0.2.0-mac-x64.dmg`),'tamper');await assert.rejects(assemble({input:stages,output:path.join(root,'changed')}),/changed/);
});
test('a partial target set and mixed-source builds never produce a public catalogue',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'sfu-release-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const fixture=await artifactFixture(root,'mac','x64');await stageRelease(fixture,proof);await assert.rejects(assemble({input:path.join(root,'stages'),output:path.join(root,'bundle')}),/four/);
  for(const [platform,arch] of [['mac','arm64'],['win','x64'],['win','arm64']]){const item=await artifactFixture(root,platform,arch);if(platform==='win'&&arch==='arm64')item.sourceSha='b'.repeat(40);await stageRelease(item,proof);}
  await assert.rejects(assemble({input:path.join(root,'stages'),output:path.join(root,'bundle')}),/consistent/);
});
