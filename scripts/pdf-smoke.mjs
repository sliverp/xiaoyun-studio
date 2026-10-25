import {createServer} from 'node:http'
import {readFileSync,mkdtempSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {once} from 'node:events'
import assert from 'node:assert/strict'
import {MediaEngine} from '../server/media.mjs'

function samplePdf(){
 const first='BT /F1 24 Tf 72 700 Td (First page: cloud agent) Tj ET',second='BT /F1 24 Tf 72 700 Td (Second page: headless broadcast) Tj ET'
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',`<< /Length ${first.length} >>\nstream\n${first}\nendstream`,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',`<< /Length ${second.length} >>\nstream\n${second}\nendstream`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
 let output='%PDF-1.4\n',offsets=[0]
 for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(output));output+=(i+1)+' 0 obj\n'+objects[i]+'\nendobj\n'}
 const xref=Buffer.byteLength(output);output+='xref\n0 8\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Root 1 0 R /Size 8 >>\nstartxref\n'+xref+'\n%%EOF\n'
 return Buffer.from(output)
}
const directory=mkdtempSync(join(tmpdir(),'studio-pdf-real-')),token='pdf-local-smoke',pdf=samplePdf(),root=new URL('../',import.meta.url)
let authenticatedReads=0
const server=createServer((req,res)=>{
 const path=new URL(req.url,'http://local').pathname
 if(path==='/assets/uploads/test.pdf'){if(req.headers['x-render-token']!==token){res.writeHead(401);return res.end()}authenticatedReads++;res.setHeader('Content-Type','application/pdf');return res.end(pdf)}
 if(path==='/vendor/pdfjs/pdf.mjs'||path==='/vendor/pdfjs/pdf.worker.mjs'){res.setHeader('Content-Type','text/javascript');return res.end(readFileSync(new URL('node_modules/pdfjs-dist/build/'+(path.endsWith('worker.mjs')?'pdf.worker.mjs':'pdf.mjs'),root)))}
 if(path==='/pdf-viewer'||path==='/pdf-viewer.mjs'){res.setHeader('Content-Type',path.endsWith('.mjs')?'text/javascript':'text/html');return res.end(readFileSync(new URL('public/'+(path==='/pdf-viewer'?'pdf-viewer.html':'pdf-viewer.mjs'),root)))}
 res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body style="background:#eaf5ff"><h1>PDF smoke program</h1></body></html>')
})
server.listen(18360,'127.0.0.1');await once(server,'listening')
const engine=new MediaEngine({dataDir:directory,baseUrl:'http://127.0.0.1:18360',renderToken:token,getSettings:()=>({output:{width:640,height:360,fps:5}})})
process.once('SIGTERM',()=>{void engine.close().finally(()=>{server.close();process.exit(143)})})
try{
 console.error('pdf-smoke: authenticated initial PDF render')
 const first=await engine.openPresentation('/assets/uploads/test.pdf')
 assert.equal(first.pageNumber,1);assert.equal(first.pageCount,2);assert.match(first.text,/First page: cloud agent/)
 console.error('pdf-smoke: native async next-page render')
 const second=await engine.nextSlide();assert.equal(second.pageNumber,2);assert.match(second.text,/Second page: headless broadcast/)
 console.error('pdf-smoke: native first-page render')
 assert.notEqual(first.pageKey,second.pageKey);assert.equal((await engine.firstSlide()).pageNumber,1)
 assert.ok(authenticatedReads>0);assert.ok(engine.getSlideFrame().length>1000)
 writeFileSync(join(directory,'pdf-slide.jpg'),engine.getSlideFrame());const result={passed:true,pages:2,currentTextVerified:true,actualPageRenderAwaited:true,authenticatedAssetFetch:true,artifactDirectory:directory};writeFileSync(join(directory,'verification.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2))
}finally{await engine.close();server.close()}
