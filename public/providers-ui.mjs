import {MAX_PROVIDER_BACKUPS,TENCENT_VOICES,speechKeys,voiceLabel} from './provider-config.mjs'

const $=id=>document.getElementById(id)
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const field=(name,label,value='',type='text')=>`<label>${label}<input type="${type}" data-route-field="${name}" value="${esc(value)}" autocomplete="${type==='password'?'new-password':'off'}"></label>`
const thinking=value=>`<label>深度思考<select data-route-field="thinking">${[['default','跟随供应商默认'],['disabled','关闭 · 减少等待'],['enabled','开启']].map(([id,label])=>`<option value="${id}" ${value===id?'selected':''}>${label}</option>`).join('')}</select></label>`
const voices=value=>[...new Set(TENCENT_VOICES.map(voice=>voice.group))].map(group=>`<optgroup label="${esc(group)}">${TENCENT_VOICES.filter(voice=>voice.group===group).map(voice=>`<option value="${voice.id}" ${value===voice.id?'selected':''}>${esc(voice.name+' · '+voice.style)}</option>`).join('')}</optgroup>`).join('')+'<option value="">自定义音色</option>'


/** Credentials stay in password fields; rendering and status use saved-presence flags only. */
export class ProviderEditor{
 constructor({markDirty,test,preview}){
  this.markDirty=markDirty;this.test=test;this.preview=preview;this.cleared=new Set();this.saved={}
  for(const kind of ['model','speech']){
   $('add-'+kind+'-backup').onclick=()=>this.add(kind)
   const list=$(kind==='model'?'fallback-editor':'speech-fallback-editor')
   list.addEventListener('input',event=>markDirty(event))
   list.addEventListener('change',event=>{const row=event.target.closest('[data-provider-row]');if(row){if(event.target.matches('[data-voice-preset]'))row.querySelector('[data-route-field="voice"]').value=event.target.value;this.visibility(row)}markDirty(event)})
   list.addEventListener('click',event=>{
    const button=event.target.closest('button'),row=button?.closest('[data-provider-row]');if(!row)return
    if(button.dataset.routeAction==='remove'){for(const input of row.querySelectorAll('[data-secret]'))this.cleared.add(input.dataset.secret);row.remove();markDirty(event);this.number(kind)}
    if(button.dataset.routeAction==='up'&&row.previousElementSibling){row.parentElement.insertBefore(row,row.previousElementSibling);markDirty(event);this.number(kind)}
    if(button.dataset.routeAction==='down'&&row.nextElementSibling){row.parentElement.insertBefore(row.nextElementSibling,row);markDirty(event);this.number(kind)}
    if(button.dataset.routeAction==='test')void test(kind,[...list.children].indexOf(row)+1)
    if(button.dataset.routeAction==='preview')void preview({slot:Number(row.dataset.slot),voice:row.querySelector('[data-route-field="voice"]').value.trim(),speed:Number(row.querySelector('[data-route-field="speed"]').value),provider:row.querySelector('[data-route-field="provider"]').value})
   })
  }
  for(const id of ['voice-preview','persona-voice-preview'])$(id).addEventListener('play',()=>{for(const other of ['voice-preview','persona-voice-preview'])if(other!==id)$(other).pause()})
  $('tts-voice-preset').innerHTML=voices('')
  $('tts-voice-preset').onchange=event=>{document.querySelector('[data-config="tts.voice"]').value=event.target.value;this.primaryVoice();markDirty(event);if(!event.target.value)document.querySelector('[data-config="tts.voice"]').focus()}
  document.querySelector('[data-config="tts.voice"]').addEventListener('input',()=>this.primaryVoice())
  document.querySelector('[data-config="tts.speed"]').addEventListener('input',()=>this.primaryVoice())
  document.querySelectorAll('[data-provider-test]').forEach(button=>button.onclick=()=>void test(button.dataset.providerTest,0))
  document.querySelectorAll('[data-provider-preview]').forEach(button=>button.onclick=()=>void preview({slot:0,voice:document.querySelector('[data-config="tts.voice"]').value.trim(),speed:Number(document.querySelector('[data-config="tts.speed"]').value),provider:$('tts-provider').value,text:$('voice-preview-text').value}))
 }
 stopPreview(){for(const id of ['voice-preview','persona-voice-preview'])$(id).pause()}
 reset(){this.signature='';this.cleared.clear();for(const id of ['provider-test-result','persona-provider-test-result'])$(id).hidden=true;for(const id of ['voice-preview','persona-voice-preview']){$(id).pause();$(id).removeAttribute('src');$(id).hidden=true}}
 hydrate(config,saved){
  const signature=JSON.stringify([config.llm?.fallbacks,config.tts?.fallbacks,saved]);this.saved=saved
  if(this.signature!==signature){this.signature=signature;this.cleared.clear();$('fallback-editor').replaceChildren();$('speech-fallback-editor').replaceChildren();for(const route of config.llm?.fallbacks||[])this.append('model',route);for(const route of config.tts?.fallbacks||[])this.append('speech',route)}
  this.number('model');this.number('speech');this.primaryVoice()
 }
 primaryVoice(){const input=document.querySelector('[data-config="tts.voice"]'),tencent=$('tts-provider').value==='tencent';$('tts-voice-preset-label').hidden=!tencent;const known=TENCENT_VOICES.some(v=>v.id===input.value);$('tts-voice-preset').value=known?input.value:'';$('tts-custom-voice-fields').hidden=tencent&&known;for(const row of document.querySelectorAll('[data-provider-row="speech"]'))this.visibility(row)}
 add(kind){
  const list=$(kind==='model'?'fallback-editor':'speech-fallback-editor');if(list.children.length>=MAX_PROVIDER_BACKUPS)return
  const used=new Set([...list.children].map(row=>kind==='model'?row.dataset.keyName:Number(row.dataset.slot)))
  const slot=Array.from({length:MAX_PROVIDER_BACKUPS},(_,i)=>i+1).find(i=>!used.has(kind==='model'?'fallbackKey'+i:i))
  const route=kind==='model'?{keyName:'fallbackKey'+slot,thinking:'default'}:{slot,provider:'tencent',voice:'501001',speed:1,usePrimaryCredentials:false,followPrimaryVoice:true}
  const names=kind==='model'?[route.keyName]:Object.values(speechKeys(slot));for(const name of names)this.cleared.add(name)
  const row=this.append(kind,route,true);this.number(kind);this.markDirty();row.querySelector('input,select')?.focus()
 }
 append(kind,route,fresh=false){
  const row=document.createElement('article');row.className='provider-route';row.dataset.providerRow=kind
  const header=`<div class="provider-route-heading"><strong data-route-title></strong><div><button type="button" class="icon-button" data-route-action="up" aria-label="提前使用此通道">↑</button><button type="button" class="icon-button" data-route-action="down" aria-label="延后使用此通道">↓</button><button type="button" class="ghost" data-route-action="remove">删除</button></div></div>`
  const secret=(name,label)=>`<label>${label}<input type="password" data-secret="${esc(name)}" autocomplete="new-password" placeholder="${!fresh&&this.saved[name]?'已保存 · 留空保持不变':'尚未配置'}"></label>`
  if(kind==='model'){
   row.dataset.keyName=route.keyName
   row.innerHTML=header+field('baseUrl','API 地址',route.baseUrl)+field('model','模型名称',route.model)+secret(route.keyName,'API Key')+thinking(route.thinking||'default')
  }else{
   row.dataset.slot=route.slot;const keys=speechKeys(route.slot)
   row.innerHTML=header+`<label>语音供应商<select data-route-field="provider"><option value="tencent" ${route.provider!=='openai'?'selected':''}>腾讯云语音</option><option value="openai" ${route.provider==='openai'?'selected':''}>兼容 Speech API</option></select></label><div data-route-tencent><label class="checkbox-label"><input type="checkbox" data-route-field="usePrimaryCredentials" ${route.usePrimaryCredentials?'checked':''}>使用主腾讯云账号</label><p class="helper">同一账号可换音色；需要应对账号失效时，请填另一账号的凭证。</p><div data-route-own-credentials>${secret(keys.secretId,'SecretId')}${secret(keys.secretKey,'SecretKey')}</div></div><div data-route-openai>${field('baseUrl','API 地址',route.baseUrl)}${field('model','模型名称',route.model||'tts-1')}${secret(keys.apiKey,'API Key')}</div><div data-route-follow><label class="checkbox-label"><input type="checkbox" data-route-field="followPrimaryVoice" ${route.followPrimaryVoice!==false?'checked':''}>跟随主用音色和语速</label><p class="helper">更换主音色时，备用同步更新，故障切换时保持主播声音一致。</p></div><p data-route-voice-warning class="helper">此备用使用独立音色，切换时声音可能改变。</p><label data-route-voice-list>选择音色<select data-voice-preset>${voices(route.voice)}</select></label><div data-route-custom-voice>${field('voice','自定义音色 ID / 名称',route.voice||'501001')}</div><label>语速（倍）<input type="number" min="0.6" max="2" step="0.05" data-route-field="speed" value="${route.speed||1}"></label>`
  }
  row.insertAdjacentHTML('beforeend',`<button type="button" class="subtle" data-route-action="${kind==='model'?'test':'preview'}">${kind==='model'?'测试连接':'试听所选音色'}</button>`)
  $(kind==='model'?'fallback-editor':'speech-fallback-editor').append(row);this.visibility(row);return row
 }
 visibility(row){
  if(row.dataset.providerRow!=='speech')return
  const tencent=row.querySelector('[data-route-field="provider"]').value==='tencent',primaryTencent=$('tts-provider').value==='tencent',shared=row.querySelector('[data-route-field="usePrimaryCredentials"]'),follow=row.querySelector('[data-route-field="followPrimaryVoice"]')
  shared.disabled=!primaryTencent;follow.disabled=!tencent||!primaryTencent
  if(!tencent||shared.disabled)shared.checked=false
  if(follow.disabled)follow.checked=false
  row.querySelector('[data-route-tencent]').hidden=!tencent;row.querySelector('[data-route-openai]').hidden=tencent;row.querySelector('[data-route-voice-list]').hidden=!tencent;row.querySelector('[data-route-follow]').hidden=follow.disabled
  const input=row.querySelector('[data-route-field="voice"]'),speed=row.querySelector('[data-route-field="speed"]'),preset=row.querySelector('[data-voice-preset]')
  if(follow.checked){input.value=document.querySelector('[data-config="tts.voice"]').value;speed.value=document.querySelector('[data-config="tts.speed"]').value}
  input.disabled=follow.checked;speed.disabled=follow.checked;preset.disabled=follow.checked
  const voice=input.value,known=TENCENT_VOICES.some(v=>v.id===voice);preset.value=known?voice:''
  row.querySelector('[data-route-custom-voice]').hidden=tencent&&known;row.querySelector('[data-route-own-credentials]').hidden=shared.checked;row.querySelector('[data-route-voice-warning]').hidden=follow.checked
 }

 number(kind){const list=$(kind==='model'?'fallback-editor':'speech-fallback-editor');[...list.children].forEach((row,i)=>{row.querySelector('[data-route-title]').textContent='备用 '+(i+1);row.querySelector('[data-route-action="up"]').disabled=i===0;row.querySelector('[data-route-action="down"]').disabled=i===list.children.length-1});$('add-'+kind+'-backup').disabled=list.children.length>=MAX_PROVIDER_BACKUPS;$(kind+'-backup-empty').hidden=Boolean(list.children.length)}
 read(){
  const read=row=>Object.fromEntries([...row.querySelectorAll('[data-route-field]')].map(input=>[input.dataset.routeField,input.type==='checkbox'?input.checked:input.type==='number'?Number(input.value):input.value.trim()]))
  const models=[...$('fallback-editor').children].map(row=>{const route=read(row);if(!route.baseUrl||!route.model)throw new Error('备用模型的地址和名称需要一起填写');return {...route,keyName:row.dataset.keyName}})
  const speech=[...$('speech-fallback-editor').children].map(row=>({...read(row),slot:Number(row.dataset.slot),region:'ap-guangzhou'}))
  return {models,speech,secrets:Object.fromEntries([...this.cleared].map(name=>[name,null]))}
 }
 status(status={}){
  for(const kind of ['model','speech']){
   const active=kind==='model'?status:status.speech||{},routes=status[kind+'Routes']||[]
   $(kind+'-provider-status').textContent=routes.length?routes.map((route,i)=>{const health=route.error?'异常 · '+route.error:route.lastSuccessAt?'可用 · '+(route.elapsedMs/1000).toFixed(1)+'秒':route.configured?'待测试':'未配置';return `${i?'备用 '+i:'主用'}：${kind==='speech'?(voiceLabel(route.voice,route.provider)||route.label):(route.model||route.label)} · ${health}`}).join('\n'):'尚未配置通道'
   $(kind+'-active-route').textContent=active.changedAt?`最近使用：${active.fallback?'备用 '+active.route:'主用'}${active.cached?' · 命中语音缓存':''}`:'按主用、备用顺序自动切换'
  }
 }
}
