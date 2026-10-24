import {getDocument,GlobalWorkerOptions} from '/vendor/pdfjs/pdf.mjs'
GlobalWorkerOptions.workerSrc='/vendor/pdfjs/pdf.worker.mjs'
const canvas=document.querySelector('#pdf-canvas'),counter=document.querySelector('#counter'),text=document.querySelector('#pdf-text'),error=document.querySelector('#error'),previous=document.querySelector('#prev'),next=document.querySelector('#next')
const params=new URLSearchParams(location.search),file=new URL(params.get('file')||'',location.origin)
let pdf,current=0,rendering=Promise.resolve(),activeRender=null
window.studioPdfLoading=true
function showError(cause){window.studioPdfError=String(cause?.message||cause);window.studioPdfLoading=false;error.hidden=false;error.textContent='PDF 无法打开：'+window.studioPdfError}
async function drawPage(number){
 if(!Number.isInteger(number)||number<1||number>pdf.numPages)return false
 window.studioPdfLoading=true
 const page=await pdf.getPage(number),base=page.getViewport({scale:1}),scale=Math.min((innerWidth-20)/base.width,(innerHeight-62)/base.height),viewport=page.getViewport({scale})
 canvas.width=Math.max(1,Math.round(viewport.width));canvas.height=Math.max(1,Math.round(viewport.height))
 activeRender=page.render({canvasContext:canvas.getContext('2d',{alpha:false}),viewport,background:'rgb(255,255,255)'})
 await activeRender.promise;activeRender=null
 const content=await page.getTextContent();text.textContent=content.items.map(item=>item.str||'').join(' ').replace(/\s+/g,' ').trim()
 current=number;counter.dataset.slideNumber=String(number);counter.dataset.slideCount=String(pdf.numPages);counter.textContent=number+' / '+pdf.numPages;document.title='PDF 第 '+number+' 页 · 小云 Studio'
 previous.disabled=number<=1;next.disabled=number>=pdf.numPages
 const url=new URL(location.href);url.searchParams.set('page',String(number));history.replaceState(null,'',url)
 window.studioPdfLoading=false;return true
}
function goToPage(number){rendering=rendering.then(()=>drawPage(number)).catch(cause=>{showError(cause);throw cause});window.studioPdfReady=rendering;return rendering}
window.nextSlide=()=>goToPage(current+1);window.prevSlide=()=>goToPage(current-1);window.studioDeck={goToSlide:number=>goToPage(Number(number))}
previous.addEventListener('click',()=>window.prevSlide().catch(showError));next.addEventListener('click',()=>window.nextSlide().catch(showError))
addEventListener('keydown',event=>{if(['ArrowRight','PageDown'].includes(event.key)){event.preventDefault();window.nextSlide().catch(showError)}if(['ArrowLeft','PageUp'].includes(event.key)){event.preventDefault();window.prevSlide().catch(showError)}})
addEventListener('resize',()=>{if(current)goToPage(current).catch(showError)})
window.studioPdfReady=(async()=>{
 if(file.origin!==location.origin||!file.pathname.startsWith('/assets/'))throw new Error('请先把 PDF 上传到素材库')
 const response=await fetch(file.href,{credentials:'same-origin'});if(!response.ok)throw new Error('素材读取失败（'+response.status+'）')
 const bytes=new Uint8Array(await response.arrayBuffer());pdf=await getDocument({data:bytes,isEvalSupported:false,enableXfa:false,useSystemFonts:true}).promise
 const initial=Math.max(1,Math.min(pdf.numPages,Number(params.get('page'))||1));return drawPage(initial)
})().catch(cause=>{showError(cause);throw cause})
