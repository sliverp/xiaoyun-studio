import {createStudio} from './http.mjs'
const app=await createStudio()
console.log('小云 Studio 已启动：http://'+(process.env.STUDIO_HOST||'127.0.0.1')+':'+app.server.address().port)
if(app.auth.firstRun)console.log('首次登录密码保存在：'+app.dataDir+'/first-login.txt（仅本机可读）')
let stopping=false
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(stopping)return;stopping=true;const deadline=setTimeout(()=>process.exit(1),12000);deadline.unref();await app.close();process.exit(0)})
