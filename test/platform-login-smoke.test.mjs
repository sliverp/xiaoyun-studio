import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {createLoginNetworkDiagnostics,observeLoginEvidence} from '../scripts/platform-login-diagnostics.mjs'

test('login diagnostics retain only bounded host/status counts and attach before navigation',async()=>{
 const page=new EventEmitter(),browser=new EventEmitter();browser.newPage=async()=>page
 const diagnostics=createLoginNetworkDiagnostics();diagnostics.bindBrowser(browser)
 const opened=await browser.newPage();assert.equal(opened.listenerCount('response'),1);assert.equal(opened.listenerCount('requestfailed'),1)
 opened.emit('response',{url:()=> 'https://user:private-password@channels.weixin.qq.com/login?private-token=do-not-retain',status:()=>403,headers:()=>{throw new Error('Headers must not be read')}})
 opened.emit('requestfailed',{url:()=> 'https://channels.weixin.qq.com/login?private-token=do-not-retain',failure:()=>({errorText:'net::ERR_CONNECTION_RESET'})})
 opened.emit('requestfailed',{url:()=> 'https://channels.weixin.qq.com/login?private-token=do-not-retain',failure:()=>({errorText:'A failed URL with a private-token=do-not-retain'})})
 const snapshot=diagnostics.snapshot()
 assert.equal(snapshot.httpErrorCount,1);assert.equal(snapshot.failedRequestCount,2)
 assert.deepEqual(snapshot.responses,[{host:'channels.weixin.qq.com',status:403,count:1}])
 assert.deepEqual(snapshot.failures.map(row=>row.code),['net::ERR_CONNECTION_RESET','request-failed'])
 assert.doesNotMatch(JSON.stringify(snapshot),/private|login\?|https:|password/)
 for(let index=0;index<100;index++)opened.emit('response',{url:()=>`https://cdn-${index}.example.test/`,status:()=>200})
 assert.equal(diagnostics.snapshot().responses.length,64);assert.ok(diagnostics.snapshot().omittedGroups>0)
})

test('login observation waits through QR loading and stops when the actual pattern appears',async()=>{
 let now=0,captures=0
 const collector={capture:async()=>{captures++},status:()=>({browserOpen:true,qrVisible:captures===4})}
 const observed=await observeLoginEvidence(collector,{now:()=>now,sleep:async milliseconds=>{now+=milliseconds}})
 assert.equal(observed.stopReason,'qr-visible');assert.equal(observed.captures,4);assert.equal(observed.elapsedMs,3000)
})

test('an unresolved login page is observed for 25 seconds, while a safety challenge stops immediately',async()=>{
 let now=0
 const collector={capture:async()=>{},status:()=>({browserOpen:true,qrVisible:false})}
 const observed=await observeLoginEvidence(collector,{now:()=>now,sleep:async milliseconds=>{now+=milliseconds}})
 assert.equal(observed.stopReason,'deadline');assert.equal(observed.elapsedMs,25000);assert.equal(observed.captures,25)
 collector.status=()=>({browserOpen:true,qrVisible:false,loginPage:{verificationRequired:true}})
 const challenged=await observeLoginEvidence(collector,{now:()=>now,sleep:async()=>{throw new Error('A challenge must not be retried')}})
 assert.equal(challenged.stopReason,'security-verification');assert.equal(challenged.captures,1)
})
