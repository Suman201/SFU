"use strict";
const fs=require('node:fs');const path=require('node:path');
try {
  if(!process.env.RUNNER_TEMP)throw new Error('A runner temporary directory is required.');
  const file=path.join(process.env.RUNNER_TEMP,'sfu-notary.p8');
  if(process.argv[2]==='remove'){fs.rmSync(file,{force:true});}
  else if(process.argv[2]==='create'){
    const key=process.env.APPLE_API_KEY_CONTENT??'';
    if(!key.startsWith('-----BEGIN PRIVATE KEY-----')||!key.includes('-----END PRIVATE KEY-----')||key.length>16384)throw new Error('Configure APPLE_API_KEY_P8 with the Apple API private key.');
    fs.writeFileSync(file,key,{mode:0o600,flag:'wx'});
    if(!process.env.GITHUB_ENV)throw new Error('Run key preparation inside the release workflow.');
    fs.appendFileSync(process.env.GITHUB_ENV,'APPLE_API_KEY='+file+'\n');
  }else throw new Error('Choose create or remove.');
}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
