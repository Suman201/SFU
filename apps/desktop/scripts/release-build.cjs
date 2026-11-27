"use strict";
const {spawnSync,execFileSync}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const {releaseConfiguration}=require('./release-config.cjs');
try {
  const config=releaseConfiguration(process.env), root=path.resolve(__dirname,'../../..');
  if(process.env.SFU_DESKTOP_RELEASE!=='true'||process.platform!==(config.platform==='mac'?'darwin':'win32'))throw new Error('Signed releases must run on the matching native platform.');
  if(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()!==process.env.SFU_DESKTOP_SOURCE_SHA)throw new Error('The release source commit does not match the approved plan.');
  if(fs.existsSync(path.join(root,'apps/desktop/release')))throw new Error('Use a clean builder output directory for each release target.');
  function run(args,cwd=root,signing=false){const env={...process.env,SFU_DESKTOP_UPDATE_URL:config.updateUrl};if(!signing)for(const key of ['CSC_LINK','CSC_KEY_PASSWORD','APPLE_API_KEY','APPLE_API_KEY_ID','APPLE_API_ISSUER','AZURE_TENANT_ID','AZURE_CLIENT_ID','AZURE_CLIENT_SECRET'])delete env[key];const result=spawnSync(process.execPath,args,{cwd,env,stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)throw new Error('Desktop release build failed.');}
  if(!process.env.npm_execpath){const candidates=[path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')];process.env.npm_execpath=candidates.find(file=>fs.existsSync(file));}
  if(!process.env.npm_execpath)throw new Error('Node.js with npm is required.');
  run([process.env.npm_execpath,'run','build:frontend','-w','@native-sfu/desktop']);
  run([path.join(root,'apps/desktop/scripts/prepare-assets.cjs')]);
  run([require.resolve('electron-builder/cli.js'),'--config','electron-builder.cjs','--'+config.platform,'--'+config.arch,'--publish','never'],path.join(root,'apps/desktop'),true);
}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
