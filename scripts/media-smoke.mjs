/** Run real isolated Chromium, local RTMP, recording, audio and PDF integration checks. */
import {spawn} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'

const root=fileURLToPath(new URL('../',import.meta.url))
async function run(name){
  const started=performance.now(),child=spawn(process.execPath,[`scripts/${name}.mjs`],{cwd:root,stdio:['ignore','pipe','pipe']})
  let stdout='',stderr='',timedOut=false
  child.stdout.on('data',chunk=>{stdout=(stdout+chunk.toString()).slice(-128*1024)})
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-64*1024)})
  let force
  const timeout=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');force=setTimeout(()=>child.kill('SIGKILL'),10000);force.unref()},90000)
  child.once('exit',()=>{clearTimeout(timeout);clearTimeout(force)})
  try{
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
    if(code!==0)throw new Error(`${name} ${timedOut?'timed out':'failed'} (exit ${code}).\n${stderr.slice(-8000)}`)
    const result=JSON.parse(stdout.trim())
    if(result.passed!==true)throw new Error(`${name} did not report successful verification`)
    return {...result,elapsedMs:Math.round(performance.now()-started)}
  }finally{clearTimeout(timeout);clearTimeout(force)}
}
const started=performance.now(),checks={};let failedCheck='',failure=''
for(const name of ['engine-smoke','pdf-smoke','app-smoke','audio-monitor-smoke','multistream-smoke']){
 try{checks[name]=await run(name)}catch(error){failedCheck=name;failure=String(error.message);break}
}
const result={passed:!failure,platform:process.platform,node:process.version,elapsedMs:Math.round(performance.now()-started),checks,...(failure?{failedCheck,error:failure}:{})}
if(process.env.STUDIO_SMOKE_REPORT)writeFileSync(process.env.STUDIO_SMOKE_REPORT,JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify(result,null,2))
if(failure){console.error(failure);process.exitCode=1}
