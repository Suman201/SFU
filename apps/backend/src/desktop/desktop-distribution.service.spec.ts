import { describe, it, expect } from '@jest/globals';
import { validateDesktopCatalogue, DesktopDistributionService } from './desktop-distribution.service';
import { ConfigService } from '@nestjs/config';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
function catalogue() {
  return { schemaVersion: 1, available: true, version: '0.2.0', publishedAt: new Date().toISOString(), notes: 'Verified desktop release.', downloads: ['mac','win'].flatMap(platform => ['x64','arm64'].map(arch => { const name = `Sapiovian Classroom-0.2.0-${platform}-${arch}.${platform==='mac'?'dmg':'exe'}`;return { platform,arch,name,url:'https://downloads.school.edu/classroom/releases/0.2.0/'+platform+'/'+arch+'/'+encodeURIComponent(name),bytes:123456,sha256:'a'.repeat(64),verification:platform==='mac'?'signed-and-notarized':'signed' }; })) };
}
describe('Desktop distribution catalogue',()=>{
  it('exposes only four approved signed installers and strips private release fields',()=>{
    const value={...catalogue(),privateKey:'must-not-be-returned',sourceSha:'internal-only'};
    const result=validateDesktopCatalogue(value,['https://downloads.school.edu']);expect(result.downloads).toHaveLength(4);expect(JSON.stringify(result)).not.toMatch(/privateKey|sourceSha|internal-only/);
  });
  it('rejects unsigned, partial, redirected, malformed or duplicate downloads',()=>{
    for(const mutate of [(v:ReturnType<typeof catalogue>)=>{v.downloads[0]!.verification='unsigned';},(v:ReturnType<typeof catalogue>)=>{v.downloads.pop();},(v:ReturnType<typeof catalogue>)=>{v.downloads[0]!.url='https://evil.school.edu/fake.exe';},(v:ReturnType<typeof catalogue>)=>{v.downloads[0]!.url+='?token=private';},(v:ReturnType<typeof catalogue>)=>{v.downloads[0]!.sha256='bad';},(v:ReturnType<typeof catalogue>)=>{v.downloads[1]=v.downloads[0]!;}]){const data=catalogue();mutate(data);expect(()=>validateDesktopCatalogue(data,['https://downloads.school.edu'])).toThrow();}
  });
  it('fails closed when missing, invalid or oversized and reads an atomically replaced catalogue',async()=>{
    const root=await mkdtemp(join(tmpdir(),'sfu-catalogue-'));try{const file=join(root,'desktop-release.json');const config=new ConfigService({desktopDistribution:{manifestPath:file,downloadOrigins:['https://downloads.school.edu']}}),service=new DesktopDistributionService(config);
      expect((await service.catalogue()).available).toBe(false);await writeFile(file,JSON.stringify(catalogue()));expect((await service.catalogue()).available).toBe(true);await writeFile(file,'x'.repeat(65537));expect((await service.catalogue()).available).toBe(false);
    }finally{await rm(root,{recursive:true,force:true});}
  });
});
