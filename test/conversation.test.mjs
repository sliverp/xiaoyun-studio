import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Conversation} from '../server/conversation.mjs'

test('audience context is bounded, ignores old draw entries and carries preferences after applying them',()=>{
 const c=new Conversation(),now=Date.now()
 assert.equal(c.acceptComments([{id:'old',content:'请举例',at:now-121000},{id:'draw',content:'请抽奖',lotteryId:'round',at:now}]),false)
 assert.equal(c.acceptComments([{id:'beginner',nickname:'观众',content:'我是新手，请少用术语，用租房的例子解释。',at:now}]),true)
 c.aired({id:'reply',kind:'comment',text:'可以，接着用日常例子说明。',audienceIds:['beginner']},1)
 assert.equal(c.context().audienceRequests[0].status,'answered')
 c.aired({id:'source',kind:'source',text:'这个概念就像租房。',appliedRequestIds:['beginner']},2)
 assert.equal(c.context().audienceRequests.length,0);assert.equal(c.context().activePreferences[0].id,'beginner');assert.doesNotMatch(c.context().activePreferences[0].content,/租房/)
 for(let i=0;i<50;i++){c.acceptComments([{id:'q'+i,content:'问题'+i+'？',at:now}]);c.aired({id:'s'+i,kind:'source',text:'完整讲解。'},i)}
 assert.equal(c.requests.length,12);assert.equal(c.turns.length,10)
 c.reset();assert.equal(c.context().recentTurns.length,0);assert.equal(c.requests.length,0)
})

test('greetings after a choice question are not persistent requests or choice answers',()=>{
 const c=new Conversation(),at=Date.now()
 c.aired({id:'choice',kind:'engagement',text:'想听 A 部署还是 B 计费？'},1)
 assert.equal(c.acceptComments(['你好','小云你好','hello','支持主播','随便聊聊'].map((content,i)=>({id:'g'+i,content,at}))),false)
 assert.equal(c.outstanding().length,0)
 c.acceptComments([{id:'choice-a',content:'A',at}])
 assert.equal(c.outstanding()[0].followThrough,true);assert.match(c.outstanding()[0].replyTo,/部署/)
})

test('answered factual questions leave the work queue while follow-through requests remain until aired',()=>{
 const c=new Conversation(),at=Date.now()
 c.acceptComments([{id:'model',content:'你用什么模型？',at},{id:'example',content:'用租房举个例子',at}])
 assert.equal(c.outstanding().length,2)
 c.aired({id:'reply',kind:'comment',text:'我用混元 Hy4，接着用租房举例。',audienceIds:['model','example']},1)
 assert.deepEqual(c.outstanding().map(row=>row.id),['example'])
 assert.equal(c.requests.find(row=>row.id==='model').status,'answered')
 c.aired({id:'source',kind:'source',text:'租房就是按需使用房间。',appliedRequestIds:['example']},1)
 assert.equal(c.outstanding().length,0)
})
