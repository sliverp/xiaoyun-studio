/** Bound private browser operations and close only processes created by the caller. */
export function browserDeadline(promise,milliseconds,message){
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Object.assign(new Error(message),{code:'STUDIO_BROWSER_TIMEOUT'})),milliseconds)
  timer.unref?.()
  Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve(value)},error=>{clearTimeout(timer);reject(error)})
 })
}

/** Await orderly exit, then terminate only this Puppeteer browser's own child when needed. */
export async function closePlatformBrowser(browser){
 if(!browser)return
 const child=browser.process?.()
 try{await browserDeadline(browser.close(),5000,'平台浏览器关闭超时')}
 catch(error){
  if(child&&child.exitCode===null&&child.signalCode===null){
   const exited=new Promise(done=>child.once('exit',done));child.kill('SIGKILL')
   await browserDeadline(exited,2000,'平台浏览器进程尚未退出')
  }else if(browser.connected)throw error
 }
}
