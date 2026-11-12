import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {Store} from '../server/store.mjs'

test('moving scene data to another installation resolves protected demo audio from the new root',t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'studio-portability-')),root=resolve(import.meta.dirname,'..')
 t.after(()=>rmSync(dataDir,{recursive:true,force:true}))
 const original=new Store({root,dataDir,env:{}});original.update({identity:{name:'迁移后的主播'}})
 const saved=JSON.parse(readFileSync(original.file,'utf8'));saved.tts.demoAsset='/previous-installation/public/demo/greeting.mp3';writeFileSync(original.file,JSON.stringify(saved))
 const moved=new Store({root,dataDir,env:{}})
 assert.equal(moved.get().tts.demoAsset,join(root,'public/demo/greeting.mp3'))
 assert.equal(moved.get().identity.name,'迁移后的主播');assert.deepEqual(moved.get().cues,original.get().cues)
 assert.throws(()=>moved.update({tts:{demoAsset:'/arbitrary/file.mp3'}}),/不可通过设置修改/)
})
