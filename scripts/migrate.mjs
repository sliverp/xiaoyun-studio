/** Import selected presentation/voice assets into this app only; never copy accounts or running intent. */
import {existsSync,mkdirSync,readdirSync,readFileSync,copyFileSync,lstatSync,writeFileSync} from 'node:fs'
import {resolve,join,extname} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {atomicJson} from '../server/store.mjs'
import {ProjectLibrary} from '../server/projects.mjs'
const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1]},source=option('--source')
if(!source){console.error('用法：npm run migrate -- --source /path/to/previous-project [--apply] [--data .data]');process.exit(1)}
const root=resolve(import.meta.dirname,'..'),origin=resolve(source),dataDir=resolve(option('--data')||join(root,'.data'))
if(origin===root||dataDir===origin||dataDir.startsWith(origin+'/'))throw new Error('导入目录不能位于旧项目中')
const store=new ProjectLibrary({root,dataDir,env:{}}).activeStore,id='imported-'+randomUUID(),folder=join(dataDir,'assets',id),entries=[]
mkdirSync(folder,{recursive:true,mode:0o700})
function copyTree(from,to){mkdirSync(to,{recursive:true,mode:0o700});let count=0;for(const name of readdirSync(from)){const src=join(from,name),stat=lstatSync(src);if(stat.isSymbolicLink())continue;if(stat.isDirectory())count+=copyTree(src,join(to,name));else if(['.html','.js','.css','.json','.png','.jpg','.jpeg','.svg','.webp','.mp3','.wav'].includes(extname(name).toLowerCase())){copyFileSync(src,join(to,name));count++}}return count}
const deck=join(origin,'materials/live-1024-deck/site');let files=0,deckUrl='',notes=''
if(existsSync(join(deck,'index.html'))){files+=copyTree(deck,join(folder,'deck'));deckUrl='/assets/uploads/'+id+'/deck/index.html';entries.push({id:id+'-deck',name:'导入的直播演示稿',type:'html',url:deckUrl,createdAt:Date.now()});const noteFile=join(origin,'materials/live-1024-deck/merged-notes.txt');if(existsSync(noteFile))notes=readFileSync(noteFile,'utf8')}
let scripts={};const scriptsFile=join(origin,'materials/live-1024-scripts.json');if(existsSync(scriptsFile))scripts=JSON.parse(readFileSync(scriptsFile,'utf8'))
const texts=new Map(Object.entries(scripts).filter(([,v])=>typeof v==='string').map(([k,v])=>[createHash('sha256').update(v).digest('hex'),{title:k==='welcomeScript'?'导入的开场口播':k==='closingScript'?'导入的结束口播':k,text:v}]))
const client=join(origin,'plugin/lib/client.js');if(existsSync(client)){const sourceText=readFileSync(client,'utf8'),start=sourceText.indexOf('const STAGE_CUES = '),end=start>=0?sourceText.indexOf(';',start):-1;if(start>=0&&end>start){try{const cues=JSON.parse(sourceText.slice(start+'const STAGE_CUES = '.length,end));for(const cue of cues)texts.set(createHash('sha256').update(cue.text).digest('hex'),cue)}catch{/* Only literal JSON cue arrays are imported, never executable code. */}}}
const manifestFile=join(origin,'plugin/lib/stage-audio/manifest.json'),cues=[]
if(existsSync(manifestFile)){const manifest=JSON.parse(readFileSync(manifestFile,'utf8'));mkdirSync(join(folder,'audio'),{recursive:true});for(const [key,item] of Object.entries(manifest.cues||{})){if(!/^[a-z0-9-]+\.[a-f0-9]{16}\.mp3$/.test(item.file))continue;const src=join(origin,'plugin/lib/stage-audio',item.file);if(!existsSync(src))continue;const bytes=readFileSync(src);if(createHash('sha256').update(bytes).digest('hex')!==item.sha256)throw new Error('旧录音校验未通过：'+key);copyFileSync(src,join(folder,'audio',item.file));files++;const transcript=texts.get(item.textSha256);const url='/assets/uploads/'+id+'/audio/'+item.file;cues.push({id:'legacy-'+key,title:transcript?.title||key,text:transcript?.text||'',audioUrl:url});entries.push({id:key,name:transcript?.title||key,type:'audio',url,size:bytes.length,createdAt:Date.now()})}}
const index=join(dataDir,'assets.json');let old=[];if(existsSync(index))old=JSON.parse(readFileSync(index,'utf8'));atomicJson(index,[...old,...entries].slice(-2000))
if(args.includes('--apply')){const patch={cues:[...store.get().cues,...cues].slice(-100)};if(deckUrl)patch.presentation={url:deckUrl,notes,loop:true};if(scripts.systemPrompt)patch.identity={systemPrompt:scripts.systemPrompt,welcome:scripts.welcomeScript||store.get().identity.welcome,goodbye:scripts.closingScript||store.get().identity.goodbye};store.update(patch)}
atomicJson(join(dataDir,'last-import.json'),{at:Date.now(),files,deckImported:Boolean(deckUrl),audioCues:cues.length,applied:args.includes('--apply'),credentialsCopied:false,browserProfilesCopied:false,productionModified:false})
console.log(JSON.stringify({importedFiles:files,presentation:deckUrl||null,audioCues:cues.length,applied:args.includes('--apply'),credentialsCopied:false,productionModified:false},null,2))
