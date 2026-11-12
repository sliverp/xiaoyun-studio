/** Keep the dedicated login window alive across actual helper process exits. */
import {spawn} from 'node:child_process'
import {mkdir,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import puppeteer from 'puppeteer-core'

export async function launchLocalBrowser(options){
 const {executablePath,userDataDir,timeout=30000}=options
 if(!executablePath||!userDataDir)throw new Error('本机浏览器需要独立的资料目录')
 await mkdir(userDataDir,{recursive:true,mode:0o700})
 const portFile=join(userDataDir,'DevToolsActivePort'),previous=await readFile(portFile,'utf8').catch(()=>null)
 // Puppeteer.launch installs a process-exit hook even with all handleSIG* flags disabled.
 // Spawn this owned window independently, then use the public CDP connect API.
 const args=puppeteer.defaultArgs({...options,args:[...(options.args||[]),'--remote-debugging-address=127.0.0.1','--remote-debugging-port=0']})
 const child=spawn(executablePath,args,{detached:true,stdio:'ignore',env:options.env||process.env})
 let failed=false;child.once('error',()=>{failed=true});child.once('exit',()=>{failed=true});child.unref()
 const deadline=Date.now()+timeout
 try{
  while(Date.now()<deadline){
   if(failed)throw new Error('本机浏览器未能启动，请检查浏览器安装或关闭占用此连接的旧窗口')
   const content=await readFile(portFile,'utf8').catch(()=>null)
   if(content&&content!==previous){
    const [port,path]=content.trim().split('\n')
    if(/^\d+$/.test(port)&&Number(port)>0&&Number(port)<=65535&&/^\/devtools\/browser\/[\w-]+$/.test(path)){
     let cancelled=false
     const pending=puppeteer.connect({browserWSEndpoint:'ws://127.0.0.1:'+Number(port)+path,defaultViewport:options.defaultViewport??null,protocolTimeout:options.protocolTimeout||30000})
     pending.then(browser=>{if(cancelled)browser.disconnect()},()=>{})
     let timer
     try{
      const browser=await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('本机浏览器连接超时')),Math.max(1,deadline-Date.now()))})])
      Object.defineProperty(browser,'process',{value:()=>child})
      return browser
     }catch(error){cancelled=true;throw error}finally{clearTimeout(timer)}
    }
   }
   await new Promise(done=>setTimeout(done,100))
  }
  throw new Error('本机浏览器启动超时，请重试')
 }catch(error){if(child.pid&&!failed)child.kill('SIGKILL');throw error}
}
