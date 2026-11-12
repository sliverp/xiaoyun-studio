/** Real process exits, rather than an in-process disconnect, must preserve the owned browser. */
import assert from 'node:assert/strict'
import {fork} from 'node:child_process'
import http from 'node:http'
import {once} from 'node:events'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import puppeteer from 'puppeteer-core'
import {detectTools} from '../server/media.mjs'

const directory=await mkdtemp(join(tmpdir(),'studio-browser-lifecycle-'))
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Offline login fixture</title>')})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
const origin='http://127.0.0.1:'+server.address().port,args=[]
if(process.env.CHROMIUM_NO_SANDBOX==='1'||process.getuid?.()===0)args.push('--no-sandbox')
const worker=join(directory,'worker.mjs')
await writeFile(worker,`
import {launchLocalBrowser} from ${JSON.stringify(new URL('./local-browser-launch.mjs',import.meta.url).href)};
const browser=await launchLocalBrowser(${JSON.stringify({executablePath:detectTools().chromium.path,userDataDir:join(directory,'profile'),headless:true,args})});
process.send({endpoint:browser.wsEndpoint(),pid:browser.process().pid});
process.on('message',()=>{browser.disconnect();process.exit(0)});
`)
let child,browser,pid
try{
 child=fork(worker,[],{stdio:['ignore','ignore','inherit','ipc']})
 const ready=await Promise.race([once(child,'message').then(([value])=>value),once(child,'exit').then(()=>{throw Error('Browser worker exited before ready')})]);pid=ready.pid
 browser=await puppeteer.connect({browserWSEndpoint:ready.endpoint,defaultViewport:null})
 const page=await browser.newPage();await page.goto(origin)
 await browser.defaultBrowserContext().setCookie({name:'fixture_auth',value:'fixture-only',url:origin,httpOnly:true})
 await page.evaluate(()=>{localStorage.setItem('fixture-local','kept');sessionStorage.setItem('fixture-session','kept')})
 const exited=once(child,'exit');child.send('exit');assert.equal((await exited)[0],0)
 browser.disconnect();browser=await puppeteer.connect({browserWSEndpoint:ready.endpoint,defaultViewport:null})
 const restored=(await browser.pages()).find(p=>p.url().startsWith(origin));assert.ok(restored)
 assert.deepEqual(await restored.evaluate(()=>[localStorage.getItem('fixture-local'),sessionStorage.getItem('fixture-session')]),['kept','kept'])
 assert.equal((await browser.defaultBrowserContext().cookies()).find(c=>c.name==='fixture_auth')?.httpOnly,true)
 // A fresh owning process can also crash without taking down the surviving window.
 const adopter=join(directory,'adopter.mjs')
 await writeFile(adopter,`import puppeteer from ${JSON.stringify(import.meta.resolve('puppeteer-core'))};const b=await puppeteer.connect({browserWSEndpoint:${JSON.stringify(ready.endpoint)},defaultViewport:null});process.send('ready');setInterval(()=>{},1000);`)
 child=fork(adopter,[],{stdio:['ignore','ignore','inherit','ipc']});await once(child,'message')
 const crashed=once(child,'exit');child.kill('SIGKILL');assert.equal((await crashed)[1],'SIGKILL')
 assert.equal(await restored.title(),'Offline login fixture');process.kill(pid,0)
}finally{
 if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')
 if(browser?.connected)await browser.close();else if(pid)try{process.kill(pid,'SIGKILL')}catch{}
 await new Promise(done=>server.close(done));await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100})
}
console.log(JSON.stringify({passed:true,realHelperExitPreservesBrowser:true,crashedAdopterPreservesBrowser:true,sameWindowAndPage:true,httpOnlyCookiePreserved:true,localAndSessionStoragePreserved:true,actualAccountUsed:false}))
