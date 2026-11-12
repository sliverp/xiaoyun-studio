import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {resolve,join} from 'node:path'
import {Store,defaults} from '../server/store.mjs'
import {ProjectLibrary} from '../server/projects.mjs'
const root=resolve(import.meta.dirname,'..')
const directory=t=>{const dir=mkdtempSync(join(tmpdir(),'studio-program-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir}

test('one or multiple explicit rules survive saving, reloading and copying a reusable scene',t=>{
 const dataDir=directory(t),library=new ProjectLibrary({root,dataDir,env:{}}),store=library.activeStore
 store.update({program:{opening:false,closing:false,order:['source','engagement','comment','sale','lottery'],enabled:{lottery:true,sale:false}},live:{engagementMinTurns:1,engagementCooldownSeconds:15},lottery:{enabled:true,triggers:['comment','fixed'],commentTriggerKeyword:'想抽奖',fixedTimes:['12:00','18:00']}})
 const reloaded=new Store({root,dataDir:store.dataDir,env:{}}).get()
 assert.deepEqual(reloaded.lottery.triggers,['comment','fixed']);assert.equal(reloaded.program.closing,false)
 const copied=library.create({name:'带互动的副本',copyCurrent:true});assert.deepEqual(library.openStore(copied.id).get().program,reloaded.program)
 store.update({lottery:{triggers:['comment']}});assert.deepEqual(store.get().lottery.triggers,['comment'])
})

test('legacy automatic rules remain enabled only where the old fields configured them',t=>{
 const dataDir=directory(t),saved=defaults(root);delete saved.program;delete saved.lottery.triggers;delete saved.lottery.popularityMetric;delete saved.live.engagementPrompt
 Object.assign(saved.lottery,{enabled:true,intervalMinutes:60,popularityThreshold:100,fixedTimes:['12:00']})
 writeFileSync(join(dataDir,'settings.json'),JSON.stringify(saved))
 const config=new Store({root,dataDir,env:{}}).get()
 assert.deepEqual(config.lottery.triggers,['interval','popularity','fixed']);assert.equal(config.lottery.popularityMetric,'heat');assert.equal(config.program.opening,true)
})

test('invalid selected rules or impossible program sequences cannot partly replace saved settings',t=>{
 const store=new Store({root,dataDir:directory(t),env:{}});store.update({});const before=store.get(),bytes=readFileSync(store.file,'utf8')
 for(const patch of [
  {lottery:{enabled:true,triggers:[]}},
  {lottery:{enabled:true,triggers:['popularity'],popularityThreshold:0}},
  {lottery:{enabled:true,triggers:['fixed'],fixedTimes:[]}},
  {lottery:{enabled:true,triggers:['comment'],commentTriggerKeyword:''}},
  {lottery:{triggers:['comment','comment']}},
  {lottery:{triggers:['missing']}},
  {program:{order:['source','source','comment','sale','lottery']}},
  {program:{enabled:{source:false,comment:false,engagement:false,lottery:false,sale:false}}},
 ])assert.throws(()=>store.update(patch))
 assert.deepEqual(store.get(),before);assert.equal(readFileSync(store.file,'utf8'),bytes)
})

test('campaign artwork and community entry survive reload while older scenes keep the default frame',t=>{
 const dataDir=directory(t),saved=defaults(root);delete saved.scene.backgroundUrl;delete saved.scene.layout.template
 writeFileSync(join(dataDir,'settings.json'),JSON.stringify(saved))
 const store=new Store({root,dataDir,env:{}});assert.equal(store.get().scene.layout.template,'default');assert.equal(store.get().scene.backgroundUrl,'')
 store.update({scene:{backgroundUrl:'/assets/campaign.png',communityQrUrl:'/assets/community.png',layout:{template:'campaign'}}})
 assert.equal(new Store({root,dataDir,env:{}}).get().scene.backgroundUrl,'/assets/campaign.png')
 const before=store.get();for(const scene of [{backgroundUrl:'https://example.com/private.png'},{layout:{template:'missing'}}])assert.throws(()=>store.update({scene}));assert.deepEqual(store.get(),before)
})

test('minimum lecture paragraphs are editable, persist and migrate to three for old scenes',t=>{
 const dataDir=directory(t),saved=defaults(root);delete saved.live.minPageTurns;writeFileSync(join(dataDir,'settings.json'),JSON.stringify(saved))
 const store=new Store({root,dataDir,env:{}});assert.equal(store.get().live.minPageTurns,3);store.update({live:{minPageTurns:5}});assert.equal(new Store({root,dataDir,env:{}}).get().live.minPageTurns,5)
 for(const value of [0,13,2.5])assert.throws(()=>store.update({live:{minPageTurns:value}}),/讲解段数/)
 assert.equal(store.get().live.minPageTurns,5)
})
