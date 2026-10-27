/** Independent broadcast configurations and private runtime directories under one shared service. */
import {randomUUID} from 'node:crypto'
import {existsSync,mkdirSync,readFileSync,cpSync,copyFileSync,chmodSync,lstatSync,statSync,renameSync,rmSync} from 'node:fs'
import {join,resolve,dirname,extname,sep} from 'node:path'
import {Store,atomicJson} from './store.mjs'

const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const LEGACY_ENTRIES=['settings.json','secrets.json','director-history.json','broadcast-events.ndjson','renderer-profile','channels-profile','platforms','audio','recordings']
const TRANSIENT_BROWSER_FILES=new Set(['SingletonLock','SingletonSocket','SingletonCookie','DevToolsActivePort'])
const fail=(status,message)=>Object.assign(new Error(message),{status})
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)
const onlyKeys=(value,keys)=>plain(value)&&Object.keys(value).every(key=>keys.includes(key))
const nameOf=value=>{
 if(typeof value!=='string'||!value.trim()||value.trim().length>80||/[\u0000-\u001f\u007f]/.test(value))throw fail(400,'场次名称需要1–80个字，不能包含控制字符')
 return value.trim()
}
const readJson=(path,message)=>{try{return JSON.parse(readFileSync(path,'utf8'))}catch(cause){throw Object.assign(new Error(message),{cause})}}

/** Keep configured recordings playable without carrying unrelated speech-cache or session files. */
function copyReferencedAudio(config,sourceDir,destinationDir){
 const prefix='/assets/audio/',references=[config.bgm.asset,...config.cues.map(cue=>cue.audioUrl)].filter(address=>typeof address==='string'&&address.startsWith(prefix)),copied=new Set()
 for(const address of references){
  let relative;try{relative=decodeURIComponent(address.split(/[?#]/,1)[0].slice(prefix.length))}catch{throw new Error('引用音频路径编码无效')}
  const segments=relative.split(/[\\/]/)
  if(segments.some(part=>!part||part==='.'||part==='..')||relative.includes('\\')||relative.includes('\0')||!['.mp3','.wav','.ogg','.m4a','.aac','.flac','.opus','.webm'].includes(extname(relative).toLowerCase()))throw new Error('引用音频路径无效，必须是已完成的音频文件')
  const audioDir=join(sourceDir,'audio'),source=resolve(audioDir,relative)
  if(!source.startsWith(audioDir+sep))throw new Error('引用音频不能越过场次音频目录')
  let current=sourceDir
  for(const [index,part]of ['audio',...segments].entries()){
   current=join(current,part);const entry=lstatSync(current),last=index===segments.length
   if(entry.isSymbolicLink()||(last?!entry.isFile()||entry.size===0:!entry.isDirectory()))throw new Error('引用音频及其目录必须是非链接的完整文件')
  }
  if(copied.has(source))continue;copied.add(source)
  const destination=join(destinationDir,'audio',...segments)
  mkdirSync(dirname(destination),{recursive:true,mode:0o700});copyFileSync(source,destination);chmodSync(destination,0o600)
 }
}

export class ProjectLibrary {
 constructor({root,dataDir,env=process.env}){
  this.root=resolve(root);this.dataDir=resolve(dataDir);this.dir=join(this.dataDir,'projects');this.file=join(this.dataDir,'projects.json');this.stores=new Map()
  if(existsSync(this.dir)&&lstatSync(this.dir).isSymbolicLink())throw new Error('场次存储目录不能是链接')
  mkdirSync(this.dir,{recursive:true,mode:0o700})
  if(existsSync(this.file)){
   const saved=readJson(this.file,'场次目录文件无法读取，请检查 projects.json')
   if(!onlyKeys(saved,['version','activeId','projects'])||saved.version!==1||!Array.isArray(saved.projects)||!saved.projects.length||typeof saved.activeId!=='string')throw new Error('场次目录格式无效')
   const ids=new Set()
   for(const item of saved.projects){
    if(!onlyKeys(item,['id','name','createdAt','updatedAt'])||typeof item.id!=='string'||!ID.test(item.id)||ids.has(item.id)||nameOf(item.name)!==item.name||!Number.isSafeInteger(item.createdAt)||item.createdAt<0||!Number.isSafeInteger(item.updatedAt)||item.updatedAt<item.createdAt)throw new Error('场次记录格式无效')
    ids.add(item.id)
   }
   if(!ids.has(saved.activeId))throw new Error('当前场次记录不存在')
   this.manifest={version:1,activeId:saved.activeId,projects:saved.projects.map(({id,name,createdAt,updatedAt})=>({id,name,createdAt,updatedAt}))}
  }else{
   const record=this._createDirectory({name:'原配置',legacy:true,env})
   this.manifest={version:1,activeId:record.id,projects:[record]}
   try{this._save(this.manifest)}catch(error){this.stores.delete(record.id);rmSync(this._path(record.id),{recursive:true,force:true});throw error}
  }
 }
 get activeId(){return this.manifest.activeId}
 get activeStore(){return this.openStore()}
 _path(id){if(typeof id!=='string'||!ID.test(id))throw fail(400,'场次 ID 无效');return join(this.dir,id)}
 _record(id){this._path(id);const record=this.manifest.projects.find(item=>item.id===id);if(!record)throw fail(404,'场次不存在');return record}
 _save(manifest){atomicJson(this.file,manifest);this.manifest=manifest}
 /** List metadata only. Private configuration, vault contents and paths are never included. */
 list(){return this.manifest.projects.map(record=>{
  let updatedAt=record.updatedAt
  for(const file of ['settings.json','secrets.json']){try{updatedAt=Math.max(updatedAt,Math.ceil(statSync(join(this._path(record.id),file)).mtimeMs))}catch(error){if(error.code!=='ENOENT')throw error}}
  return {...record,updatedAt,active:record.id===this.activeId}
 })}
 /** Return the internal runtime directory for an existing, non-symlink project. */
 directory(id=this.activeId){this._record(id);const path=this._path(id);let entry;try{entry=lstatSync(path)}catch(error){if(error.code==='ENOENT')throw fail(404,'场次目录不存在');throw error}if(!entry.isDirectory()||entry.isSymbolicLink())throw fail(400,'场次目录不能是链接或普通文件');return path}
 /** Open a cached private store. Environment credentials seed the first project only. */
 openStore(id=this.activeId){
  const dataDir=this.directory(id)
  if(!this.stores.has(id)){try{this.stores.set(id,new Store({root:this.root,dataDir,env:{}}))}catch(cause){throw Object.assign(new Error('该场次的配置或密钥文件无法读取'),{cause})}}
  return this.stores.get(id)
 }
 _createDirectory({name,legacy=false,copyCurrent=false,env={}}){
  const id=randomUUID(),createdAt=Date.now(),path=this._path(id),staging=join(this.dir,'.creating-'+id)
  mkdirSync(staging,{mode:0o700})
  try{
   if(legacy){
    for(const entry of LEGACY_ENTRIES){const source=join(this.dataDir,entry);if(existsSync(source)){if(lstatSync(source).isSymbolicLink())throw new Error('原始场次文件不能是链接');cpSync(source,join(staging,entry),{recursive:true,preserveTimestamps:true,filter:(source)=>{const info=lstatSync(source);return !info.isSymbolicLink()&&!info.isSocket()&&!TRANSIENT_BROWSER_FILES.has(source.split(/[\\/]/).at(-1))}})}}
   }else if(copyCurrent){
    const source=this.openStore(),vault=readJson(source.secretFile,'当前场次密钥文件无法读取')
    if(!vault||typeof vault!=='object'||Array.isArray(vault))throw new Error('当前场次密钥格式无效')
    delete vault.commentIngestKey
    const config=source.get()
    copyReferencedAudio(config,source.dataDir,staging)
    atomicJson(join(staging,'settings.json'),config);atomicJson(join(staging,'secrets.json'),vault)
   }
   const store=new Store({root:this.root,dataDir:staging,env:legacy?env:{}})
   if(!legacy&&!copyCurrent)store.update({cues:[],presentation:{url:'',notes:''},platforms:[],sale:{enabled:false},lottery:{enabled:false}})
   atomicJson(store.file,store.get())
   renameSync(staging,path)
   // The staging store's file paths must not survive the directory rename.
   this.stores.set(id,new Store({root:this.root,dataDir:path,env:{}}))
   return {id,name:nameOf(name),createdAt,updatedAt:Date.now()}
  }catch(cause){rmSync(staging,{recursive:true,force:true});rmSync(path,{recursive:true,force:true});throw Object.assign(new Error('场次创建失败；原始配置未改动'),{cause})}
 }
 /** Create a blank broadcast or copy current settings/keys with a fresh runtime and ingest key. */
 create(options){
  if(!onlyKeys(options,['name','copyCurrent']))throw fail(400,'新建场次仅支持名称和复制当前设置选项')
  const name=nameOf(Object.hasOwn(options,'name')?options.name:undefined),copyCurrent=Object.hasOwn(options,'copyCurrent')?options.copyCurrent:false
  if(typeof copyCurrent!=='boolean')throw fail(400,'复制场次选项无效')
  const record=this._createDirectory({name,copyCurrent})
  try{this._save({...this.manifest,projects:[...this.manifest.projects,record]})}catch(error){this.stores.delete(record.id);rmSync(this._path(record.id),{recursive:true,force:true});throw error}
  return this.list().find(item=>item.id===record.id)
 }
 rename(id,name){const record=this._record(id),next={...record,name:nameOf(name),updatedAt:Date.now()};this._save({...this.manifest,projects:this.manifest.projects.map(item=>item.id===id?next:item)});return this.list().find(item=>item.id===id)}
 /** Select persisted configuration only; the HTTP owner stops and rebuilds runtime processes. */
 activate(id){this._record(id);this.openStore(id);this._save({...this.manifest,activeId:id});return this.list().find(item=>item.id===id)}
 /** Remove a non-current project only after its owning runtime has been closed by the caller. */
 remove(id){
  this._record(id);if(id===this.activeId)throw fail(409,'不能删除当前场次，请先切换到其他场次')
  const path=this.directory(id),trash=join(this.dir,'.deleting-'+id+'-'+randomUUID())
  renameSync(path,trash)
  try{this._save({...this.manifest,projects:this.manifest.projects.filter(item=>item.id!==id)})}catch(error){renameSync(trash,path);throw error}
  this.stores.delete(id);rmSync(trash,{recursive:true,force:true});return {id}
 }
}
