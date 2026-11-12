/** Browser-side helpers for the operator's authenticated video-channel backend. */
import {sessionAddressAllowed} from './browser-session.mjs'
export function focusedChannelsInput(){
 const node=document.activeElement
 return Boolean(node&&(node.matches('input:not([type="file"]):not([type="checkbox"]):not([type="radio"]),textarea')||node.isContentEditable)&&!node.disabled&&!node.readOnly)
}
export function selectFocusedChannelsInput(){
 const node=document.activeElement
 if(node?.isContentEditable){const range=document.createRange();range.selectNodeContents(node);const selection=getSelection();selection.removeAllRanges();selection.addRange(range)}
 else node.select()
}
export const CHANNEL_KEYS=new Set(['Enter','Tab','Escape','Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Space','SelectAll','Undo','Redo'])

export function coverExtension(bytes){
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>10*1024*1024)throw new Error('封面图片应为 1 字节至 10MB')
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return '.png'
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return '.jpg'
 if(/^GIF8[79]a/.test(bytes.subarray(0,6).toString('ascii')))return '.gif'
 if(bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP')return '.webp'
 throw new Error('请选择 PNG、JPEG、WebP 或 GIF 图片')
}

/** Extract only explicitly labelled visible push fields; no account or application state is read. */
export function readChannelsStreamInfo(){
 const visible=node=>node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden'
 const addressLabel=/服务器地址|推流地址|推流\s*URL|RTMP\s*(?:地址|URL)/i,keyLabel=/推流码|推流密钥|串流密钥|直播码|串流码|stream\s*key/i
 let rtmpUrl='',streamKey=''
 const record=(label,value)=>{value=String(value||'').trim();if(!rtmpUrl&&addressLabel.test(label)&&/^rtmps?:\/\/\S+$/i.test(value))rtmpUrl=value;if(!streamKey&&keyLabel.test(label)&&value&&!/^[*•●]+$/.test(value)&&!/[\s\u3400-\u9fff]/.test(value)&&value.length<4096)streamKey=value}
 for(const node of document.querySelectorAll('input,textarea')){
  if(!visible(node))continue
  let label=[...(node.labels||[])].map(n=>n.textContent).join(' ')+[node.getAttribute('aria-label'),node.placeholder,node.name,node.id].filter(Boolean).join(' ')
  if(!addressLabel.test(label)&&!keyLabel.test(label)){const text=node.parentElement?.innerText||'';if(text.length<250&&!(addressLabel.test(text)&&keyLabel.test(text)))label+=' '+text}
  record(label,node.value)
 }
 for(const node of document.querySelectorAll('label,span,p,dt,div')){
  if(!visible(node)||node.children.length||!addressLabel.test(node.textContent)&&!keyLabel.test(node.textContent))continue
  const label=node.textContent.trim();if(!/^(?:服务器地址|推流地址|推流URL|RTMP地址|RTMPURL|推流码|推流密钥|串流密钥|直播码|串流码|streamkey)$/i.test(label.replace(/[\s:：]/g,'')))continue
  let parent=node.parentElement
  for(let depth=0;parent&&depth<3;depth++,parent=parent.parentElement){
   const text=parent.innerText||'';if(text.length>450||addressLabel.test(text)&&keyLabel.test(text))break
   const input=parent.querySelector('input,textarea'),copy=[...parent.querySelectorAll('[data-clipboard-text]')].find(visible),value=input?.value||copy?.getAttribute('data-clipboard-text')||text.split('\n').map(t=>t.trim()).filter(t=>t&&t!==label&&!/^(?:复制(?:地址|密钥|推流码)?|显示|隐藏|查看)$/.test(t)).at(-1)
   if(value){record(label,value);break}
  }
 }
 return {rtmpUrl,streamKey}
}

/** Keep each address/key pair together, including the official embedded live-management page. */
export async function readChannelsPageStreamInfo(page){
 let partial={rtmpUrl:'',streamKey:''}
 for(const frame of page.frames?.()||[page]){
  if(!sessionAddressAllowed(frame.url()))continue
  const value=await frame.evaluate(readChannelsStreamInfo)
  if(value.rtmpUrl&&value.streamKey)return value
  if(value.rtmpUrl||value.streamKey)partial=value
 }
 return partial
}
