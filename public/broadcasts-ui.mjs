/** Scene-local live run history. Read-only records never hydrate the settings form. */
const $=id=>document.getElementById(id)
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
const time=value=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value))
const duration=seconds=>{const n=Math.max(0,Math.floor(seconds||0));return [Math.floor(n/3600),Math.floor(n/60)%60,n%60].map(value=>String(value).padStart(2,'0')).join(':')}
const value=number=>Number.isFinite(number)?number.toLocaleString('zh-CN'):'未采集'
const mode=record=>({external:'外部开播',recording:'本地录制',output:'推流直播'}[record.mode]||'直播')
const state=record=>({live:'进行中',ended:'已结束',interrupted:'已中断'}[record.status]||record.status)
const reason=key=>({'user-ended':'手动结束','output-stopped':'输出已停止','output-error':'输出异常','scene-switched':'切换场景','service-stopped':'服务停止','service-interrupted':'服务意外中断'}[key]||key)
const metrics={onlineUsers:'在线人数',peakOnlineUsers:'平台最高在线',totalViewers:'累计观看人数',totalViews:'累计观看次数',views:'观看次数',likes:'点赞',heat:'热度',newFollowers:'新增关注',shares:'分享',groupJoins:'进群',giftCoins:'礼物币'}

export class BroadcastHistory{
 constructor({api,getSceneId,onError,action}){
  Object.assign(this,{api,getSceneId,onError,action});this.reset()
  $('broadcast-refresh').addEventListener('click',()=>this.refresh().catch(onError))
  $('broadcast-list').addEventListener('click',event=>{const button=event.target.closest('[data-broadcast-id]');if(button)this.select(button.dataset.broadcastId).catch(onError)})
  $('broadcast-list-prev').addEventListener('click',()=>{this.offset=Math.max(0,this.offset-20);this.refresh().catch(onError)})
  $('broadcast-list-next').addEventListener('click',()=>{this.offset+=20;this.refresh().catch(onError)})
  $('broadcast-events-prev').addEventListener('click',()=>{this.eventOffset=Math.max(0,this.eventOffset-100);this.loadDetail().catch(onError)})
  $('broadcast-events-next').addEventListener('click',()=>{this.eventOffset+=100;this.loadDetail().catch(onError)})
  $('broadcast-event-filter').addEventListener('change',()=>{this.eventOffset=0;this.loadDetail().catch(onError)})
  $('external-broadcast-start').addEventListener('click',()=>action('broadcast.external.start',{},$('external-broadcast-start')).catch(()=>{}))
  $('broadcast-end').addEventListener('click',()=>action('broadcast.end',{},$('broadcast-end')).catch(()=>{}))
 }
 reset(){
  this.epoch=(this.epoch||0)+1;this.offset=0;this.eventOffset=0;this.selected=null;this.items=[];this.total=0;this.listRequest=0;this.detailRequest=0;this.key='';clearTimeout(this.refreshTimer)
  if($('broadcast-detail')){$('broadcast-detail').innerHTML='<p class="empty-copy">选择一场直播，查看实际播出记录。</p>';$('broadcast-events-section').hidden=true;$('broadcast-list').innerHTML='';$('broadcast-event-filter').value='all'}
 }
 visible(){return !$('panel-broadcasts').hidden&& !$('project-workspace').hidden}
 update(data){
  const current=data.active
  $('broadcast-current-title').textContent=current?`第 ${current.number} 场 · ${mode(current)}`:'尚未开播'
  $('broadcast-current-description').textContent=current?`${time(current.startedAt)} 开始 · 数据记录中`:'开始推流或录制后，自动记录新场次。'
  $('broadcast-current-duration').textContent=current?duration(current.durationSeconds):'—'
  $('broadcast-current-comments').textContent=current?String(current.commentCount):'—'
  $('broadcast-output-help').textContent=current?.mode==='external'?'当前仅记录外部直播；下播需在外部软件操作，再结束本场记录。':'推流或录制成功后自动建档。使用直播姬等外部软件时，点击「记录外部开播」开始计时。'
  $('broadcast-end').hidden=!current;$('external-broadcast-start').hidden=Boolean(current)
  const key=JSON.stringify([data.total,current?.id,current?.eventCount])
  if(key!==this.key){this.key=key;if(this.visible()){clearTimeout(this.refreshTimer);this.refreshTimer=setTimeout(()=>this.refresh().catch(this.onError),250)}}
 }
 async refresh(){
  const epoch=this.epoch,scene=this.getSceneId(),request=++this.listRequest
  const data=await this.api(`/api/broadcasts?offset=${this.offset}&limit=20`)
  if(epoch!==this.epoch||scene!==this.getSceneId()||request!==this.listRequest)return
  this.items=data.items;this.total=data.total
  if(this.offset>=this.total&&this.offset>0){this.offset=Math.max(0,this.offset-20);return this.refresh()}
  if(!this.selected&&this.items.length)this.selected=this.items[0].id
  this.renderList()
  if(this.selected)await this.loadDetail()
 }
 renderList(){
  $('broadcast-total').textContent=`${this.total} 场`
  $('broadcast-list').innerHTML=this.items.length?this.items.map(record=>`<button class="broadcast-list-item ${record.id===this.selected?'selected':''}" data-broadcast-id="${escape(record.id)}" aria-pressed="${record.id===this.selected}"><span class="broadcast-list-top"><strong>第 ${record.number} 场</strong><span class="badge ${record.status==='live'?'broadcast-live':''}">${state(record)}</span></span><span>${time(record.startedAt)}</span><small>${mode(record)} · ${duration(record.durationSeconds)} · ${record.commentCount} 条弹幕</small></button>`).join(''):'<div class="broadcast-empty"><h3>这个场景还没有直播场次</h3><p>先在直播控制中开始推流或录制，成功后会自动建立第一个场次。外部软件开播可使用「记录外部开播」。</p></div>'
  $('broadcast-list-prev').disabled=this.offset===0;$('broadcast-list-next').disabled=this.offset+20>=this.total
  $('broadcast-list-page').textContent=this.total?`${Math.floor(this.offset/20)+1} / ${Math.ceil(this.total/20)}`:'暂无记录'
 }
 async select(id){this.selected=id;this.eventOffset=0;$('broadcast-event-filter').value='all';this.renderList();await this.loadDetail()}
 async loadDetail(){
  if(!this.selected)return
  const epoch=this.epoch,id=this.selected,request=++this.detailRequest,type=$('broadcast-event-filter').value
  const data=await this.api(`/api/broadcasts/${encodeURIComponent(id)}?offset=${this.eventOffset}&limit=100&type=${type}`)
  if(epoch!==this.epoch||id!==this.selected||request!==this.detailRequest)return
  const s=data.session
  $('broadcast-detail').innerHTML=`<div class="broadcast-detail-heading"><div><p class="card-kicker">${escape(s.sceneName)}</p><h3>第 ${s.number} 场 <span class="badge ${s.status==='live'?'broadcast-live':''}">${state(s)}</span></h3><p class="helper">${mode(s)} · ${time(s.startedAt)} 开始${s.endedAt?' · '+time(s.endedAt)+' 结束':''}</p></div><a class="small-button broadcast-export" href="/api/broadcasts/${escape(s.id)}/export" download>导出本场 JSON</a></div><div class="broadcast-stat-grid"><div><strong>${duration(s.durationSeconds)}</strong><small>本场时长</small></div><div><strong>${value(s.peakOnline)}</strong><small>单个平台最高在线</small></div><div><strong>${s.commentCount}</strong><small>已收弹幕</small></div><div><strong>${s.metricCount}</strong><small>指标采样</small></div></div>${s.endReason?`<p class="helper">结束原因：${escape(reason(s.endReason))}</p>`:''}<div class="broadcast-platforms">${s.platforms.length?s.platforms.map(p=>`<div class="broadcast-platform"><strong>${escape(p.connectionName||p.platform)}</strong><div><span>最高在线 <b>${value(p.peakOnline)}</b></span><span>累计观看人数 <b>${value(p.latest.totalViewers)}</b></span><span>点赞 <b>${value(p.latest.likes)}</b></span><span>已收弹幕 <b>${p.commentCount}</b></span></div></div>`).join(''):'<p class="helper">暂未收到平台人数与弹幕数据。可以在直播过程中连接采集。</p>'}</div>${s.recordings.length?`<div class="broadcast-recordings">录像：${s.recordings.map(file=>`<a href="/assets/recordings/${encodeURIComponent(file)}" download>${escape(file)}</a>`).join('')}</div>`:''}`
  $('broadcast-history-scope').textContent=s.scope
  $('broadcast-events-section').hidden=false
  $('broadcast-events').innerHTML=data.events.length?data.events.map(event=>this.eventRow(event)).join(''):'<p class="empty-copy">本场尚无此类记录。</p>'
  $('broadcast-events-prev').disabled=this.eventOffset===0;$('broadcast-events-next').disabled=data.nextOffset===null
  $('broadcast-events-page').textContent=data.events.length?`第 ${this.eventOffset+1}–${this.eventOffset+data.events.length} 条`:'暂无记录'
 }
 eventRow(event){
  const d=event.data||{};let label,text
  if(event.type==='comment'){label=d.nickname||'观众';text=d.content}
  else if(event.type==='metrics'){label='人数与互动';text=Object.entries(metrics).filter(([key])=>Number.isFinite(d[key])).map(([key,title])=>`${title} ${value(d[key])}`).join(' · ')}
  else if(event.type==='output'){label='播出状态';text=({stopped:'输出已停止',streaming:'输出进行中',starting:'正在启动',reconnecting:'正在重连',degraded:'部分平台异常',stopping:'正在停止',error:'输出异常'}[d.state]||d.state)+(d.recording?' · 正在录制':'')}
  else if(event.type==='speech'){label='AI 口播';text=d.text}
  else if(event.type==='lottery'){label='抽奖结果';text=`${d.winner?.nickname||'已完成开奖'} · ${d.prize||''}`}
  else{label=({'session.started':'本场开始','session.ended':'本场结束','session.interrupted':'服务中断',start:'AI 开始',pause:'AI 暂停',resume:'AI 继续',stop:'AI 停止',recovery:'播报恢复',error:'运行异常'}[event.type]||event.type);text=d.message||reason(d.reason)||''}
  return `<article class="broadcast-event"><time>${time(event.at)}</time><div><strong>${escape(label)}${d.connectionName?` <small>· ${escape(d.connectionName)}</small>`:''}</strong><p>${escape(text)}</p></div></article>`
 }
}
