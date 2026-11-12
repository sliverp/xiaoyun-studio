import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {Store, defaults} from '../server/store.mjs'
import {ProjectLibrary} from '../server/projects.mjs'
import {getPersonaPreset, isPersonaCustomized} from '../public/personas.mjs'

const root=resolve(import.meta.dirname,'..')
function directory(t){const dir=mkdtempSync(join(tmpdir(),'studio-personas-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir}

test('applying a built-in persona supplies its editable prompt and preserves identity, voice and show settings',t=>{
  const store=new Store({root,dataDir:directory(t),env:{}})
  store.update({identity:{name:'我的主播'},scene:{avatarName:'画面名称'},tts:{voice:'custom-voice'}})
  const before=store.get(),result=store.update({identity:{personaId:'commerce'}})
  assert.equal(result.identity.personaId,'commerce')
  assert.equal(result.identity.systemPrompt,getPersonaPreset('commerce').prompt)
  assert.equal(result.identity.name,before.identity.name)
  assert.equal(result.identity.welcome,before.identity.welcome)
  assert.equal(result.identity.goodbye,before.identity.goodbye)
  assert.deepEqual(result.scene,before.scene)
  assert.deepEqual(result.tts,before.tts)
  assert.deepEqual(result.cues,before.cues)
})

test('customized preset prompts survive reload and selecting custom never replaces the prompt',t=>{
  const dataDir=directory(t),store=new Store({root,dataDir,env:{}})
  const prompt=getPersonaPreset('commerce').prompt+'\n本场重点：为第一次接触产品的观众讲清规格。'
  store.update({identity:{personaId:'commerce',systemPrompt:prompt}})
  const reloaded=new Store({root,dataDir,env:{}})
  assert.equal(reloaded.get().identity.personaId,'commerce')
  assert.equal(reloaded.get().identity.systemPrompt,prompt)
  assert.equal(isPersonaCustomized('commerce',prompt),true)
  reloaded.update({identity:{personaId:'custom'}})
  assert.equal(reloaded.get().identity.systemPrompt,prompt)
  reloaded.update({identity:{systemPrompt:'完全自定义的主播设定。'}})
  assert.equal(reloaded.get().identity.personaId,'custom')
})

test('legacy settings retain exact user prompts and recognize the original built-in prompt',t=>{
  for(const prompt of ['已有场次的自定义人格，不应被内置模板替换。',getPersonaPreset('xiaoyun').prompt]){
    const dataDir=directory(t),legacy=defaults(root)
    delete legacy.identity.personaId
    legacy.identity.systemPrompt=prompt
    writeFileSync(join(dataDir,'settings.json'),JSON.stringify(legacy))
    const config=new Store({root,dataDir,env:{}}).get()
    assert.equal(config.identity.systemPrompt,prompt)
    assert.equal(config.identity.personaId,prompt===getPersonaPreset('xiaoyun').prompt?'xiaoyun':'custom')
  }
})

test('invalid persona metadata cannot change a saved configuration',t=>{
  const store=new Store({root,dataDir:directory(t),env:{}}),before=store.get()
  for(const personaId of ['missing','constructor',null,{},1])assert.throws(()=>store.update({identity:{personaId}}),/人格/)
  assert.deepEqual(store.get(),before)
})

test('copying a broadcast preserves its persona while new broadcasts retain the default',t=>{
  const library=new ProjectLibrary({root,dataDir:directory(t),env:{}}),original=library.openStore()
  original.update({identity:{personaId:'commerce'}})
  const copied=library.create({name:'带货场次副本',copyCurrent:true})
  const copy=library.openStore(copied.id)
  assert.equal(copy.get().identity.personaId,'commerce')
  assert.equal(copy.get().identity.systemPrompt,getPersonaPreset('commerce').prompt)
  copy.update({identity:{personaId:'custom',systemPrompt:'副本单独调整。'}})
  assert.equal(original.get().identity.personaId,'commerce')
  const blank=library.create({name:'空白分享'})
  assert.equal(library.openStore(blank.id).get().identity.personaId,'xiaoyun')
})
