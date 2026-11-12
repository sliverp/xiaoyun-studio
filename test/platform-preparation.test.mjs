import test from 'node:test'
import assert from 'node:assert/strict'
import {videoChannelPreparation,streamErrorPresentation} from '../public/platform-preparation.mjs'
import {LocalWorkspaceTickets} from '../server/local-workspace.mjs'

test('an authenticated backend without push information never looks ready to stream',()=>{
 const state=videoChannelPreparation({rtmpUrl:'',streamKeySaved:false,preparation:{serverVerifiedAt:1000},chat:{browserOpen:true,loginRequired:false}})
 assert.deepEqual(state.steps.map(step=>step.done),[true,true,false]);assert.equal(state.configured,false);assert.equal(state.action,'prepare');assert.match(state.headline,/还缺推流信息/)
})
test('a stopped destination retains its old error as history without continuing to raise a live alarm',()=>{
 const error='previous remote End of file'
 for(const state of ['stopped','idle','disabled','not-configured'])assert.deepEqual(streamErrorPresentation({state,active:false,error}),{current:'',previous:error})
 for(const state of ['starting','reconnecting','error'])assert.deepEqual(streamErrorPresentation({state,active:false,error}),{current:error,previous:''})
 assert.deepEqual(streamErrorPresentation({state:'streaming',active:true,error}),{current:error,previous:''})
})
test('local login alone asks for platform setup, detected push fields ask for sync, and only saved credentials offer start',()=>{
 const value={rtmpUrl:'',streamKeySaved:false,preparation:{browser:'edge',localOnline:true,localLoggedIn:true},chat:{}}
 assert.equal(videoChannelPreparation(value).action,'prepare');assert.equal(videoChannelPreparation(value).verified,false)
 value.preparation.localStreamReady=true;assert.equal(videoChannelPreparation(value).action,'sync')
 value.preparation.serverVerifiedAt=1000;value.rtmpUrl='rtmp://fixture.test/live';value.streamKeySaved=true;assert.equal(videoChannelPreparation(value).action,'start')
 value.preparation.localNeedsSync=true;assert.equal(videoChannelPreparation(value).action,'sync');value.preparation.localNeedsSync=false;
 value.chat.loginRequired=true;value.preparation.localLoggedIn=false;assert.equal(videoChannelPreparation(value).action,'start')
})
test('saved push credentials remain usable without backend login or session synchronization',()=>{
 for(const chat of [{},{loginRequired:true,state:'login-required'},{loginRequired:true,state:'login-required',browserOpen:true}]){
  const flow=videoChannelPreparation({rtmpUrl:'rtmp://fixture.test/live',streamKeySaved:true,chat,preparation:{serverVerifiedAt:1000}})
  assert.equal(flow.action,'start');assert.equal(flow.configured,true);assert.match(flow.detail,/弹幕/)
  if(chat.loginRequired){assert.equal(flow.verified,false);assert.match(flow.detail,/仅影响弹幕/)}
 }
 const failed=videoChannelPreparation({rtmpUrl:'rtmp://fixture.test/live',streamKeySaved:true,chat:{loginRequired:true},stream:{state:'error',active:false}})
 assert.equal(failed.action,'start');assert.equal(failed.label,'重试推流')
})
test('workspace handoff is single-use, short-lived and scene-bound',()=>{
 let now=1000;const tickets=new LocalWorkspaceTickets({now:()=>now}),scope={projectId:'scene',connectionId:'video',browser:'edge'}
 const first=tickets.create(scope);assert.throws(()=>tickets.consume(first.workspaceTicket,'other'));assert.equal(tickets.consume(first.workspaceTicket,'scene').connectionId,'video');assert.throws(()=>tickets.consume(first.workspaceTicket,'scene'))
 const second=tickets.create(scope);now=second.expiresAt;assert.throws(()=>tickets.consume(second.workspaceTicket,'scene'))
})
test('active and pending output always replace the start action even when setup data is stale',()=>{
 for(const stream of [{active:true,state:'streaming'},...['preparing','starting','running','streaming','reconnecting','stopping'].map(state=>({active:false,state}))]){
  const value=videoChannelPreparation({stream,chat:{loginRequired:true},preparation:{localOnline:true,localNeedsSync:true}})
  assert.equal(value.live,true);assert.equal(value.action,'stop');assert.doesNotMatch(value.label,/开始/)
  assert.equal(value.stopping,stream.state==='stopping')
 }
 assert.equal(videoChannelPreparation({stream:{active:false,state:'stopped'}}).live,false)
})
