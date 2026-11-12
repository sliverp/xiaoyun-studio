/** Exercise the actual helper page, including stale links, closed tabs and helper restarts. */
import assert from 'node:assert/strict'
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import puppeteer from 'puppeteer-core'
import {createLocalBrowserHelper} from './local-browser-helper.mjs'
import {detectTools} from '../server/media.mjs'

const directory=await mkdtemp(join(tmpdir(),'studio-helper-ui-')),browsers=[],errors=[]
const args=['--disable-dev-shm-usage'];if(process.env.CHROMIUM_NO_SANDBOX==='1'||process.getuid?.()===0)args.push('--no-sandbox')
const grant={platform:'wechat',projectId:'fixture-scene',connectionId:'fixture-account',name:'测试视频号',expiresAt:Date.now()+120000}
const launch=async options=>{
 const browser=await puppeteer.launch(options);browsers.push(browser);const newPage=browser.newPage.bind(browser)
 browser.newPage=async()=>{const page=await newPage();await page.setRequestInterception(true);page.on('request',request=>{if(request.isInterceptResolutionHandled())return;if(new URL(request.url()).hostname==='channels.weixin.qq.com')void request.respond({status:200,contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8"><nav data-studio-authenticated="true">视频号助手</nav><h1>测试直播后台</h1>'});else void request.continue()});return page}
 return browser
}
const options={servers:['https://studio.example'],port:0,dataDir:directory,headless:true,launch,fetchImpl:async()=>Response.json(grant)}
let helper=await createLocalBrowserHelper(options),controller,page,closed=false
try{
 controller=await puppeteer.launch({executablePath:detectTools().chromium.path,headless:true,args});page=await controller.newPage();page.on('pageerror',error=>errors.push(error.message));await page.setViewport({width:1280,height:920})
 await page.goto(helper.baseUrl);await page.waitForFunction(()=>document.getElementById('name').textContent==='尚未连接小云');assert.equal(await page.$eval('#open',n=>n.disabled),true)
 const {id}=await helper.pair({serverUrl:'https://studio.example',token:'a'.repeat(43)}),port=Number(new URL(helper.baseUrl).port)
 await page.goto(helper.baseUrl+'/connections/'+'f'.repeat(32));await page.waitForFunction(()=>document.getElementById('name').textContent==='测试视频号');assert.equal(new URL(page.url()).pathname,'/connections/'+id)
 const clickOpen=async()=>{await page.waitForSelector('#open:not([disabled])');const response=page.waitForResponse(r=>r.url().endsWith('/api/open'));await page.click('#open');const result=await response;assert.equal(result.status(),200);assert.equal((await result.json()).opened,true);await page.waitForFunction(()=>document.getElementById('result').textContent.includes('后台已打开'))}
 await clickOpen();assert.equal(browsers.length,1)
 for(const site of await browsers[0].pages())if(site.url().startsWith('https://channels.weixin.qq.com/'))await site.close()
 await clickOpen();assert.equal(browsers.length,1,'a closed site tab must be recreated in its existing browser');assert.ok((await browsers[0].pages()).some(site=>site.url().startsWith('https://channels.weixin.qq.com/')))
 const registry=JSON.parse(await readFile(join(directory,'connections.json'),'utf8'));assert.equal(registry[0].id,id);assert.equal((await stat(join(directory,'connections.json'))).mode&511,384)
 await helper.close({keepBrowsers:true});closed=true;assert.equal(browsers[0].process().exitCode,null,'restarting the helper keeps its Chrome window open')
 helper=await createLocalBrowserHelper({...options,port});closed=false;await page.reload();await page.waitForFunction(()=>document.getElementById('name').textContent==='测试视频号');await clickOpen();assert.equal(browsers.length,1,'the restarted helper must adopt its owned Chrome instead of launching a locked profile')
 await page.goto(helper.baseUrl+'/#connection=missing-old-link');await page.waitForFunction(()=>document.getElementById('name').textContent==='测试视频号');assert.equal(new URL(page.url()).pathname,'/connections/'+id)
 assert.deepEqual(errors,[])
}finally{await controller?.close();if(!closed)await helper.close();for(const browser of browsers)if(browser.connected)await browser.close();for(const browser of [controller,...browsers])for(const stream of browser?.process()?.stdio||[])stream?.unref?.();await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
console.log(JSON.stringify({passed:true,emptyPageDoesNotPretendToConnect:true,staleLinksRecover:true,closedTabsReopen:true,connectionSurvivesHelperRestart:true,ownedChromeAdopted:true,privateRegistry:true,pageErrors:errors,actualAccountUsed:false},null,2))
