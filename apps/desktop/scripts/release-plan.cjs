"use strict";
const fs=require('node:fs');
const {execFileSync}=require('node:child_process');
const {publicUrl}=require('./release-config.cjs');
const VERSION=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
try {
  const version=require('../package.json').version;
  if(process.env.GITHUB_REF!=='refs/heads/main'||!VERSION.test(version)||process.env.RELEASE_VERSION!==version)throw new Error('Dispatch from main and select the exact desktop package version.');
  if((process.env.RELEASE_NOTES??'').length>2000)throw new Error('Release notes are limited to 2000 characters.');
  for(const key of ['SFU_DESKTOP_SERVER_URL','SFU_DESKTOP_WEBSITE_URL','SFU_DESKTOP_ADMIN_URL'])publicUrl(process.env[key],true);
  publicUrl(process.env.SFU_DESKTOP_DISTRIBUTION_URL);
  const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  if(sha!==process.env.GITHUB_SHA||!/^[a-f0-9]{40}$/.test(sha))throw new Error('Release source does not match the workflow commit.');
  if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,'sha='+sha+'\n');
  process.stdout.write('Desktop '+version+' release source and destinations are valid.\n');
}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
