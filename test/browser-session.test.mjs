import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeBrowserSession} from '../server/browser-session.mjs'
import {LocalLoginGrants} from '../server/local-login.mjs'
import {createLocalBrowserHelper} from '../scripts/local-browser-helper.mjs'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
const session=()=>({version:1,platform:'wechat',entryUrl:'https://channels.weixin.qq.com/platform/live/home',userAgent:'fixture browser',cookies:[{domain:'.channels.weixin.qq.com',name:'fixture-auth',value:'fixture-private-value',path:'/',httpOnly:true,secure:true,extra:'omit'}],origins:[{origin:'https://channels.weixin.qq.com',localStorage:[['key','value']],sessionStorage:[['session','value']]}]})
test('portable state preserves HttpOnly cookies and site storage without accepting unrelated websites or arbitrary properties',()=>{
 const value=normalizeBrowserSession(session());assert.equal(value.cookies[0].httpOnly,true);assert.equal(value.cookies[0].extra,undefined);assert.equal(value.origins[0].sessionStorage[0][1],'value')
 for(const change of [s=>s.cookies[0].domain='.example.com',s=>s.origins[0].origin='https://evil.test',s=>s.entryUrl='https://channels.weixin.qq.com.evil.test/',s=>s.userAgent='',s=>s.origins[0].localStorage=[['key','a'.repeat(768*1024)]]]){const value=session();change(value);assert.throws(()=>normalizeBrowserSession(value))}
})
test('local grants expire, bind exactly one scene and connection, and cannot be replayed',()=>{
 let now=1000;const grants=new LocalLoginGrants({now:()=>now}),a=grants.create({projectId:'scene-a',connectionId:'account-a',name:'账号甲'})
 assert.equal(grants.get(a.token,'scene-a').connectionId,'account-a');assert.throws(()=>grants.get(a.token,'scene-b'));assert.throws(()=>grants.get('bad','scene-a'))
 grants.consume(a.token,'scene-a');assert.throws(()=>grants.consume(a.token,'scene-a'))
 const b=grants.create({projectId:'scene-a',connectionId:'account-b'});now=b.expiresAt;assert.throws(()=>grants.get(b.token,'scene-a'))
 assert.ok(!JSON.stringify([...grants.entries.keys()]).includes(a.token),'raw grants must not be retained as map keys')
})
test('the loopback helper requires its local nonce and rejects foreign origins and unconfigured servers',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'studio-helper-auth-'));let calls=0
 const helper=await createLocalBrowserHelper({servers:['https://studio.example'],port:0,dataDir:directory,fetchImpl:async()=>{calls++;throw new Error('must not call')}})
 t.after(async()=>{await helper.close();await rm(directory,{recursive:true,force:true})})
 assert.equal((await fetch(helper.baseUrl+'/api/status')).status,401)
 const html=await fetch(helper.baseUrl).then(r=>r.text()),nonce=/name="local-token" content="([a-f0-9]+)"/.exec(html)[1]
 assert.equal((await fetch(helper.baseUrl+'/api/pair',{method:'POST',headers:{'X-Local-Token':nonce,Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'})).status,400)
 await assert.rejects(helper.pair({serverUrl:'https://evil.example',token:'invalid'}),/仅允许/);assert.equal(calls,0)
})
