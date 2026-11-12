import {existsSync} from 'node:fs'
import {join} from 'node:path'
import {detectTools} from '../server/media.mjs'
export function localBrowserPath(kind){
 if(kind==='chrome')return detectTools().chromium.path
 if(kind!=='edge')throw new Error('请选择 Edge 或 Chrome')
 const paths=['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge','/usr/bin/microsoft-edge','/usr/bin/microsoft-edge-stable',...['PROGRAMFILES','PROGRAMFILES(X86)','LOCALAPPDATA'].map(key=>process.env[key]&&join(process.env[key],'Microsoft','Edge','Application','msedge.exe')).filter(Boolean)]
 const path=paths.find(existsSync);if(!path)throw new Error('未找到 Microsoft Edge，请先在本机安装 Edge');return path
}
