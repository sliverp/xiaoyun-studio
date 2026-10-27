import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync,statSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {Store,atomicJson} from '../server/store.mjs'
import {ProjectLibrary} from '../server/projects.mjs'

const root=resolve(import.meta.dirname,'..')
const fixture=t=>{const dataDir=mkdtempSync(join(tmpdir(),'studio-projects-'));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));return dataDir}

test('first migration copies configuration, private keys, exact history and browser data without altering originals',t=>{
 const dataDir=fixture(t),source=new Store({root,dataDir,env:{}})
 source.update({identity:{name:'原场主播'},lottery:{prizes:['文化衫','公仔']}});source.setSecrets({llmKey:'fixture-original-key'})
 const platform=source.savePlatform({platform:'bilibili',name:'原直播间',roomUrl:'123',streamKey:'fixture-original-stream-key'})
 const oldSettings=readFileSync(source.file),oldSecrets=readFileSync(source.secretFile),history=JSON.stringify({version:1,lotteryHistory:[{winner:{nickname:'原中奖人'}}]})
 writeFileSync(join(dataDir,'director-history.json'),history);writeFileSync(join(dataDir,'broadcast-events.ndjson'),'old-event\n')
 for(const directory of ['renderer-profile','channels-profile','platforms/'+platform.id+'/browser-profile','audio','recordings','assets']){mkdirSync(join(dataDir,directory),{recursive:true});writeFileSync(join(dataDir,directory,'original.bin'),'original-private-data')}
 symlinkSync('/nonexistent-browser-process',join(dataDir,'renderer-profile','SingletonLock'))
 writeFileSync(join(dataDir,'auth.json'),'root-auth');writeFileSync(join(dataDir,'assets.json'),'[]')
 const library=new ProjectLibrary({root,dataDir,env:{STUDIO_LLM_KEY:'fixture-bootstrap-env-key'}}),directory=library.directory(),store=library.openStore()
 assert.notEqual(directory,dataDir);assert.equal(library.list()[0].name,'原配置');assert.equal(store.get().identity.name,'原场主播')
 assert.equal(store.secret('llmKey'),'fixture-bootstrap-env-key');assert.equal(store.platformSecret(platform.id),'fixture-original-stream-key');assert.equal(store.secret('commentIngestKey'),source.secret('commentIngestKey'))
 assert.equal(readFileSync(join(directory,'director-history.json'),'utf8'),history);assert.equal(readFileSync(join(directory,'recordings','original.bin'),'utf8'),'original-private-data')
 assert.equal(readFileSync(join(directory,'platforms',platform.id,'browser-profile','original.bin'),'utf8'),'original-private-data')
 assert.equal(existsSync(join(directory,'renderer-profile','SingletonLock')),false);assert.equal(existsSync(join(directory,'auth.json')),false);assert.equal(existsSync(join(directory,'assets')),false)
 assert.deepEqual(readFileSync(source.file),oldSettings);assert.deepEqual(readFileSync(source.secretFile),oldSecrets);assert.equal(readFileSync(join(dataDir,'auth.json'),'utf8'),'root-auth')
 assert.equal(statSync(store.secretFile).mode&0o777,0o600)
})

test('blank broadcasts retain general defaults but have no cues, deck, platforms or inherited provider keys',t=>{
 const library=new ProjectLibrary({root,dataDir:fixture(t),env:{STUDIO_LLM_KEY:'fixture-env-key'}}),first=library.activeId,created=library.create({name:'周五新直播'})
 const store=library.openStore(created.id),config=store.get()
 assert.equal(library.activeId,first);assert.equal(created.active,false);assert.deepEqual(config.cues,[]);assert.equal(config.presentation.url,'');assert.equal(config.presentation.notes,'');assert.deepEqual(config.platforms,[])
 assert.equal(config.sale.enabled,false);assert.equal(config.lottery.enabled,false);assert.equal(config.identity.name,'小云');assert.equal(config.scene.layout.showAvatar,true)
 assert.equal(store.secret('llmKey'),'');assert.ok(store.secret('commentIngestKey'));assert.notEqual(store.secret('commentIngestKey'),library.openStore().secret('commentIngestKey'))
 assert.deepEqual(Object.keys(created).sort(),['id','name','createdAt','updatedAt','active'].sort());assert.doesNotMatch(JSON.stringify(library.list()),/fixture-env-key|commentIngestKey|secrets|settings/)
})

test('copying current preserves configuration and provider/platform keys with fresh prize history, sessions and browser profiles',t=>{
 const library=new ProjectLibrary({root,dataDir:fixture(t),env:{}}),store=library.openStore()
 store.update({identity:{name:'新的主播'},llm:{model:'custom-model'},lottery:{prizes:['第一份礼物','第二份礼物']}});store.setSecrets({llmKey:'fixture-copy-provider'})
 const platform=store.savePlatform({platform:'douyin',roomUrl:'123',streamKey:'fixture-copy-stream'})
 writeFileSync(join(library.directory(),'director-history.json'),'used-prize-history');writeFileSync(join(library.directory(),'broadcast-events.ndjson'),'old-session')
 mkdirSync(join(library.directory(),'platforms',platform.id,'browser-profile'),{recursive:true});writeFileSync(join(library.directory(),'platforms',platform.id,'browser-profile','Cookies'),'private-browser-cookie')
 const created=library.create({name:'复制场次',copyCurrent:true}),copied=library.openStore(created.id),directory=library.directory(created.id)
 assert.deepEqual(copied.get(),store.get());assert.equal(copied.secret('llmKey'),'fixture-copy-provider');assert.equal(copied.platformSecret(platform.id),'fixture-copy-stream');assert.notEqual(copied.secret('commentIngestKey'),store.secret('commentIngestKey'))
 for(const entry of ['director-history.json','broadcast-events.ndjson','platforms','renderer-profile','channels-profile','recordings'])assert.equal(existsSync(join(directory,entry)),false)
 copied.setSecrets({llmKey:'fixture-copy-changed'});copied.update({identity:{name:'单独更改'}});assert.equal(store.secret('llmKey'),'fixture-copy-provider');assert.equal(store.get().identity.name,'新的主播')
})

test('copying current includes only referenced cue/BGM audio and rejects traversal, links and incomplete files',t=>{
 const library=new ProjectLibrary({root,dataDir:fixture(t),env:{}}),store=library.openStore(),directory=library.directory(),outside=fixture(t)
 mkdirSync(join(directory,'audio','fixed'),{recursive:true})
 writeFileSync(join(directory,'audio','fixed','named cue.wav'),'complete-cue');writeFileSync(join(directory,'audio','loop.mp3'),'complete-bgm');writeFileSync(join(directory,'audio','unused.mp3'),'unreferenced-cache');writeFileSync(join(directory,'audio','pending.mp3.tmp'),'partial')
 const cues=[{id:'saved-cue',title:'已保存口播',text:'口播正文',audioUrl:'/assets/audio/fixed/named%20cue.wav?version=1'},{id:'shared-cue',title:'共享录音',text:'共享正文',audioUrl:'/assets/uploads/shared.mp3'}]
 store.update({cues,bgm:{asset:'/assets/audio/loop.mp3'}})
 const copied=library.create({name:'保留固定音频',copyCurrent:true}),copiedDirectory=library.directory(copied.id)
 assert.equal(readFileSync(join(copiedDirectory,'audio','fixed','named cue.wav'),'utf8'),'complete-cue');assert.equal(readFileSync(join(copiedDirectory,'audio','loop.mp3'),'utf8'),'complete-bgm');assert.equal(existsSync(join(copiedDirectory,'audio','unused.mp3')),false);assert.equal(existsSync(join(copiedDirectory,'audio','pending.mp3.tmp')),false)
 assert.deepEqual(library.openStore(copied.id).get().cues,cues);assert.equal(existsSync(join(copiedDirectory,'assets')),false)
 writeFileSync(join(outside,'private.mp3'),'outside-private-audio');symlinkSync(join(outside,'private.mp3'),join(directory,'audio','linked.mp3'));symlinkSync(outside,join(directory,'audio','linked-folder'))
 const count=library.list().length
 for(const audioUrl of ['/assets/audio/%2e%2e/secrets.json','/assets/audio/linked.mp3','/assets/audio/linked-folder/private.mp3','/assets/audio/pending.mp3.tmp','/assets/audio/missing.mp3']){
  store.update({cues:[{...cues[0],audioUrl}]});assert.throws(()=>library.create({name:'无效音频依赖',copyCurrent:true}));assert.equal(library.list().length,count)
 }
 assert.equal(readFileSync(join(outside,'private.mp3'),'utf8'),'outside-private-audio');assert.equal(readFileSync(join(directory,'audio','loop.mp3'),'utf8'),'complete-bgm')
})

test('active selection and separate stores survive reload without applying global environment keys to other broadcasts',t=>{
 const dataDir=fixture(t),library=new ProjectLibrary({root,dataDir,env:{STUDIO_LLM_KEY:'fixture-first-key'}}),first=library.activeId,second=library.create({name:'第二场'})
 library.openStore(second.id).setSecrets({llmKey:'fixture-second-key'});library.activate(second.id);library.rename(second.id,'第二场新名称')
 const reloaded=new ProjectLibrary({root,dataDir,env:{STUDIO_LLM_KEY:'fixture-global-changed'}})
 assert.equal(reloaded.activeId,second.id);assert.equal(reloaded.activeStore.secret('llmKey'),'fixture-second-key');assert.equal(reloaded.openStore(first).secret('llmKey'),'fixture-first-key');assert.equal(reloaded.list().find(item=>item.active).name,'第二场新名称')
 assert.equal(reloaded.directory(),join(dataDir,'projects',second.id));assert.equal(reloaded.openStore(second.id),reloaded.activeStore)
})

test('deletion protects the active project, validates identifiers and removes only one inactive project',t=>{
 const dataDir=fixture(t),library=new ProjectLibrary({root,dataDir,env:{}}),first=library.activeId,second=library.create({name:'待删除'})
 assert.throws(()=>library.remove(first),error=>error.status===409);assert.throws(()=>library.directory('../../outside'));assert.throws(()=>library.remove('../../outside'))
 const path=library.directory(second.id);library.remove(second.id);assert.equal(existsSync(path),false);assert.equal(library.list().length,1);assert.ok(existsSync(library.directory(first)))
 assert.throws(()=>library.activate(second.id),error=>error.status===404);assert.equal(library.activeId,first)
})

test('symlink projects cannot redirect a removal or store to an outside directory',t=>{
 const dataDir=fixture(t),outside=fixture(t),library=new ProjectLibrary({root,dataDir,env:{}}),second=library.create({name:'被替换目录'}),path=library.directory(second.id)
 writeFileSync(join(outside,'keep.txt'),'keep');rmSync(path,{recursive:true});symlinkSync(outside,path)
 assert.throws(()=>library.openStore(second.id),/链接/);assert.throws(()=>library.remove(second.id),/链接/);assert.equal(readFileSync(join(outside,'keep.txt'),'utf8'),'keep');assert.equal(library.list().length,2)
})

test('invalid manifests and invalid target settings never replace the active broadcast or leak private file content',t=>{
 const dataDir=fixture(t),library=new ProjectLibrary({root,dataDir,env:{}}),active=library.activeId,target=library.create({name:'损坏配置'})
 writeFileSync(join(library.directory(target.id),'settings.json'),'{"private-fixture-content": bad-json}')
 const reloaded=new ProjectLibrary({root,dataDir,env:{}})
 assert.throws(()=>reloaded.activate(target.id),error=>!error.message.includes('private-fixture-content'));assert.equal(reloaded.activeId,active)
 const saved=JSON.parse(readFileSync(library.file,'utf8'));saved.activeId='../outside';atomicJson(library.file,saved)
 assert.throws(()=>new ProjectLibrary({root,dataDir,env:{}}),/当前场次记录不存在/)
 assert.throws(()=>library.create({name:'bad\nname'}));assert.throws(()=>library.create({name:'复制',copyCurrent:'yes'}))
})

test('project operations reject unknown or inherited options, reserved prototype fields and invalid identifiers',t=>{
 const library=new ProjectLibrary({root,dataDir:fixture(t),env:{}}),before=library.list()
 for(const options of [undefined,null,[],{name:'新场次',secret:'private-fixture-key'},Object.create({name:'继承名称'}),JSON.parse('{"name":"新场次","__proto__":{"polluted":true}}'),{name:'新场次',constructor:{prototype:{polluted:true}}}])assert.throws(()=>library.create(options),error=>error.status===400)
 for(const id of [undefined,null,{},[],123,'../outside','__proto__/outside'])for(const operation of [()=>library.rename(id,'名称'),()=>library.activate(id),()=>library.remove(id)])assert.throws(operation,error=>error.status===400)
 assert.equal(Object.prototype.polluted,undefined);assert.deepEqual(library.list(),before)
})

test('persisted project metadata rejects duplicate ids, extra fields, numeric ids and reversed timestamps',t=>{
 const dataDir=fixture(t),library=new ProjectLibrary({root,dataDir,env:{}}),saved=JSON.parse(readFileSync(library.file,'utf8'))
 const invalids=[{...saved,unexpected:'private-fixture-key'},{...saved,projects:[saved.projects[0],saved.projects[0]]},{...saved,projects:[{...saved.projects[0],id:123}]},{...saved,projects:[{...saved.projects[0],secret:'private-fixture-key'}]},{...saved,projects:[{...saved.projects[0],updatedAt:saved.projects[0].createdAt-1}]}]
 for(const invalid of invalids){atomicJson(library.file,invalid);assert.throws(()=>new ProjectLibrary({root,dataDir,env:{}}),error=>!error.message.includes('private-fixture-key'))}
 atomicJson(library.file,saved)
 assert.equal(new ProjectLibrary({root,dataDir,env:{}}).activeId,library.activeId)
})
