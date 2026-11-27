import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { startBuiltUiTestServer } from './helpers/admin-test-server';
const { startBookingStack }=require('./helpers/booking-stack.cjs');
test('public desktop downloads expose only complete verified releases and remain usable on every viewport',async({browser,request},info)=>{
  const stack=await startBookingStack(),web=await startBuiltUiTestServer(stack.origin,path.resolve('apps/frontend/dist/frontend/browser')),temp=await mkdtemp('/tmp/sfu-desktop-catalogue-');
  const context=await browser.newContext({viewport:{width:1366,height:1000}});await context.addInitScript(()=>{try{if(window.top===window&&(location.protocol==='http:'||location.protocol==='https:'))localStorage.setItem('native-sfu-theme','light');}catch{}});const page=await context.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const config=stack.app.get(require('@nestjs/config').ConfigService),file=path.join(temp,'desktop-release.json'),folder=path.resolve('reports/desktop-distribution',info.project.name);await mkdir(folder,{recursive:true});
  const base='https://downloads.school.edu/classroom/';
  const downloads=['mac','win'].flatMap(platform=>['x64','arm64'].map(arch=>{const name=`Sapiovian Classroom-0.2.0-${platform}-${arch}.${platform==='mac'?'dmg':'exe'}`;return{platform,arch,name,url:base+'releases/0.2.0/'+platform+'/'+arch+'/'+encodeURIComponent(name),bytes:125000000,sha256:'a'.repeat(64),verification:platform==='mac'?'signed-and-notarized':'signed'};}));
  try{
    config.set('desktopDistribution.manifestPath',undefined);await page.goto(web.origin+'/download');await expect(page.getByRole('heading',{name:'Desktop downloads are coming soon.'})).toBeVisible();await expect(page.locator('.download-button')).toHaveCount(0);
    config.set('desktopDistribution.manifestPath',file);config.set('desktopDistribution.downloadOrigins',['https://downloads.school.edu']);
    const catalogue={schemaVersion:1,available:true,version:'0.2.0',publishedAt:new Date().toISOString(),notes:'Synthetic acceptance catalogue. No public installers are downloaded during this test.',downloads,privateKey:'never-return-this'};
    await writeFile(file,JSON.stringify(catalogue));const response=await request.get(stack.origin+'/api/v1/desktop/releases');expect(response.status()).toBe(200);expect(response.headers()['cache-control']).toBe('no-store');expect(await response.text()).not.toContain('privateKey');
    await page.reload();await expect(page.getByRole('link',{name:'Download for macOS Apple silicon',exact:true})).toHaveAttribute('href',downloads[1].url);await expect(page.locator('.download-button')).toHaveCount(4);
    for(const width of [1366,768,390]){await page.setViewportSize({width,height:1000});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);expect((await new AxeBuilder({page}).include('.download-page').withRules(['label','button-name','color-contrast','aria-valid-attr-value']).analyze()).violations).toEqual([]);await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await page.screenshot({path:path.join(folder,'desktop-download-'+width+'.png'),fullPage:true});}
    await page.getByText('Verify this download',{exact:true}).first().click();await expect(page.locator('code').first()).toHaveText('a'.repeat(64));
    await page.setViewportSize({width:1366,height:1000});await page.getByRole('button',{name:'Switch to dark mode',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await page.evaluate(()=>{for(const animation of document.getAnimations()){const timing=animation.effect?.getComputedTiming();if(timing&&Number.isFinite(timing.endTime)){try{animation.finish();}catch{}}}});await page.setViewportSize({width:390,height:1000});expect((await new AxeBuilder({page}).include('.download-page').withRules(['label','button-name','color-contrast']).analyze()).violations).toEqual([]);await page.screenshot({path:path.join(folder,'desktop-download-dark-mobile.png'),fullPage:true});
    catalogue.downloads[0].verification='unsigned';await writeFile(file,JSON.stringify(catalogue));await page.reload();await expect(page.getByRole('heading',{name:'Desktop downloads are coming soon.'})).toBeVisible();await expect(page.locator('.download-button')).toHaveCount(0);
    expect(errors).toEqual([]);
  }finally{const cleanup=await Promise.allSettled([context.close(),web.stop(),stack.stop()]);await rm(temp,{recursive:true,force:true});for(const result of cleanup)if(result.status==='rejected')throw result.reason;}
});
