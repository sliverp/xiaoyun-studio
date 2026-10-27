import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, realpathSync } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import { atomicJson } from './store.mjs'
export const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.gif':'image/gif','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.m4a':'audio/mp4','.mp4':'video/mp4','.pdf':'application/pdf','.md':'text/markdown; charset=utf-8','.txt':'text/plain; charset=utf-8'}
const EXT={html:['.html','.htm'],image:['.png','.jpg','.jpeg','.webp','.gif'],audio:['.mp3','.wav','.ogg','.m4a'],pdf:['.pdf'],notes:['.md','.txt']}
export class Assets {
 constructor({root,dataDir,runtimeDataDir=dataDir}){this.root=root;this.dataDir=dataDir;this.runtimeDataDir=runtimeDataDir;this.dir=join(dataDir,'assets');this.file=join(dataDir,'assets.json');mkdirSync(this.dir,{recursive:true,mode:0o700});try{this.entries=JSON.parse(readFileSync(this.file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e;this.entries=[]}}
 list(){
  const result=[{id:'sample-slides',name:'小云 Studio 演示稿',url:'/assets/builtin/slides/index.html',type:'html',builtin:true}]
  for(const [file,name] of [['upbeat-loop.mp3','Upbeat Loop · 节奏轻快'],['raspberry-jam.mp3','Raspberry Jam · 清爽律动'],['dance-field.mp3','Dance Field · 鼓点'],['gymnopedie-no1.mp3','Gymnopédie · 舒缓']])result.push({id:file,name,url:'/assets/builtin/bgm/'+file,type:'audio',builtin:true})
  result.push(...this.entries)
  const recordings=join(this.runtimeDataDir,'recordings')
  try{for(const name of readdirSync(recordings).filter(n=>/^[\w.-]+\.mp4$/.test(n)).slice(-100))result.push({id:name,name,url:'/assets/recordings/'+name,type:'recording',size:statSync(join(recordings,name)).size})}catch(e){if(e.code!=='ENOENT')throw e}
  return result
 }
 resolveUrl(address){
  const pathname=new URL(address,'http://studio.local').pathname
  let base,relative
  if(pathname.startsWith('/assets/builtin/')){base=join(this.root,'public/builtin');relative=pathname.slice('/assets/builtin/'.length)}
  else if(pathname.startsWith('/assets/demo/')){base=join(this.root,'public/demo');relative=pathname.slice('/assets/demo/'.length)}
  else if(pathname.startsWith('/assets/uploads/')){base=this.dir;relative=pathname.slice('/assets/uploads/'.length)}
  else if(pathname.startsWith('/assets/audio/')){base=join(this.runtimeDataDir,'audio');relative=pathname.slice('/assets/audio/'.length)}
  else if(pathname.startsWith('/assets/recordings/')){base=join(this.runtimeDataDir,'recordings');relative=pathname.slice('/assets/recordings/'.length)}
  else throw new Error('素材地址无效')
  relative=decodeURIComponent(relative)
  if(relative.split(/[\\/]/).some(p=>p==='..'||p==='.'||!p)||relative.includes('\0'))throw new Error('素材路径无效')
  const path=resolve(base,relative)
  if(!path.startsWith(resolve(base)+sep))throw new Error('素材路径无效')
  const actual=realpathSync(path)
  if(!actual.startsWith(realpathSync(base)+sep)||!statSync(actual).isFile())throw new Error('素材不存在')
  return actual
 }
 upload(buffer,{filename,type}){
  try{filename=decodeURIComponent(filename)}catch{/* A literal filename is already valid input. */}
  const name=basename(filename||'asset').slice(0,180),extension=extname(name).toLowerCase()
  if(!EXT[type]?.includes(extension))throw new Error('素材格式不支持，请选择 HTML、图片、音频、PDF 或文本')
  if(!buffer.length||buffer.length>100*1024*1024)throw new Error('素材应为1字节至100MB')
  const id=randomUUID(),file=id+(extension==='.htm'?'.html':extension)
  writeFileSync(join(this.dir,file),buffer,{mode:0o600})
  const entry={id,name,url:'/assets/uploads/'+file,type,size:buffer.length,createdAt:Date.now()}
  this.entries.push(entry);this.entries=this.entries.slice(-2000);atomicJson(this.file,this.entries)
  return entry
 }
}
export function sendFile(req,res,path,{attachment=false,noCache=false}={}){
 const stat=statSync(path),contentType=MIME[extname(path).toLowerCase()]||'application/octet-stream',headers={'Content-Type':contentType,'X-Content-Type-Options':'nosniff','Cache-Control':noCache?'no-store':'private, max-age=120','Accept-Ranges':'bytes'}
 if(attachment)headers['Content-Disposition']='attachment; filename*=UTF-8\'\''+encodeURIComponent(basename(path))
 let start=0,end=stat.size-1,status=200
 if(req.headers.range){const range=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);if(!range){res.writeHead(416,{'Content-Range':'bytes */'+stat.size});return res.end()}start=range[1]?Number(range[1]):Math.max(0,stat.size-Number(range[2]));end=range[1]&&range[2]?Math.min(end,Number(range[2])):end;if(!Number.isSafeInteger(start)||start>end||start>=stat.size){res.writeHead(416,{'Content-Range':'bytes */'+stat.size});return res.end()}status=206;headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`}
 headers['Content-Length']=Math.max(0,end-start+1);res.writeHead(status,headers)
 if(req.method==='HEAD')return res.end()
 import('node:fs').then(({createReadStream})=>createReadStream(path,{start,end}).on('error',()=>res.destroy()).pipe(res)).catch(()=>res.destroy())
}
