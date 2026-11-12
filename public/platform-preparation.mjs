/** Push credentials and optional audience-backend login are independent. */
export function streamErrorPresentation(stream={}){
 const error=String(stream.error||''),stopped=stream.active!==true&&['stopped','idle','disabled','not-configured'].includes(stream.state||'stopped')
 return {current:stopped?'':error,previous:stopped?error:''}
}
export function videoChannelPreparation(connection){
 const prep=connection.preparation||{},chat=connection.chat||{},stream=connection.stream||{}
 const verified=Boolean(prep.serverVerifiedAt)&&chat.loginRequired!==true,sourceReady=Boolean(prep.localOnline&&prep.localLoggedIn)
 const address=Boolean(connection.rtmpUrl),key=connection.streamKeySaved===true,configured=address&&key,live=stream.active===true||['preparing','starting','running','streaming','reconnecting','stopping'].includes(stream.state),stopping=stream.state==='stopping'
 const browser=prep.browser==='chrome'?'Chrome':'Edge'
 const steps=[
  {label:'视频号登录',done:verified||sourceReady,text:chat.loginRequired?'登录已过期':verified?'已验证':sourceReady?'本机已登录':'等待扫码'},
  {label:'同步到小云',done:verified,text:verified?'已同步到服务器':sourceReady?'待同步':'等待登录'},
  {label:'推流信息',done:configured,text:sourceReady&&prep.localNeedsSync?'已读取，等待同步':configured?'地址和推流码已保存':sourceReady&&prep.localStreamReady?'已读取，等待同步':address?'缺少推流码':'尚未获取'}
 ]
 let headline,detail,action,label
 if(live){headline=stopping?'正在停止推流':stream.active?'正在推流':stream.state==='reconnecting'?'正在重连推流':'正在连接推流';detail=stopping?'正在关闭此平台的输出，请稍候。':stream.active?'小云正在发送画面和声音；弹幕采集状态见下方。':'正在连接平台，请勿重复启动；弹幕采集状态见下方。';action='stop';label=stopping?'正在停止…':'停止推流'}
 else if(sourceReady&&prep.localNeedsSync){headline='已获取新的推流信息，等待同步';detail='视频号当前的推流信息尚未同步。请先同步回小云，再开始推流。';action='sync';label='同步登录和推流信息'}
 else if(configured){headline=stream.state==='error'?'推流连接中断，可以重试':verified?'准备完成，可以开始推流':'推流信息已就绪，可以开始推流';detail=chat.loginRequired?'后台登录已过期，仅影响弹幕采集；已有推流地址和密钥可直接推流。':verified?'推流信息已就绪；后台登录只用于弹幕采集。':'已保存推流地址和密钥，可直接推流；如需弹幕，再登录视频号后台。';action='start';label=stream.state==='error'?'重试推流':'开始推流'}
 else if(!verified&&!sourceReady){headline='下一步：登录视频号';detail='在 '+browser+' 工作区完成扫码和账号选择，再同步回小云。';action='prepare';label='在 '+browser+' 准备直播'}
 else if(sourceReady&&(prep.localStreamReady||configured)){headline=configured?'下一步：同步登录状态':'已获取推流信息，等待同步';detail='点击同步，把登录和已获取的推流信息保存到此连接，然后开始小云推流。';action='sync';label='同步登录和推流信息'}
 else{headline=verified?'登录已同步，还缺推流信息':'本机已登录，请继续开播设置';detail='请在视频号完成开播设置，出现推流地址和推流码后，点击右上角「同步回小云」。';action='prepare';label='在 '+browser+' 继续设置'}
 return {verified,sourceReady,configured,live,stopping,browser,steps,headline,detail,action,label}
}
