import {test} from 'node:test'
import assert from 'node:assert/strict'
import {commentWindow,modelComments,commentReferences,fitCommentText,expandCommentIds} from '../server/comment-window.mjs'

test('the latest hundred retain delivery status instead of selecting topics in code',()=>{
 const now=Date.now(),rows=Array.from({length:1000},(_,i)=>({id:'raw-'+i,nickname:'观众'+i,content:'内容'+i,at:now}))
 rows[900].respondedAt=now;rows[901].at=now-121000;rows[902].lotteryId='draw';rows[903].resolvedInSource=true
 const window=commentWindow(rows,now),sent=modelComments(window,now),refs=commentReferences(window,sent)
 assert.equal(window.length,100);assert.equal(window[0].id,'raw-900');assert.equal(window[99].id,'raw-999')
 assert.deepEqual(window.slice(0,5).map(row=>row.replyStatus),['answered','expired','lottery','incorporated','pending'])
 assert.equal(sent.length,100);assert.equal(sent[0].id,'c1');assert.equal(sent[99].id,'c100');assert.equal(refs.get('c100').id,'raw-999')
 assert.equal(sent[0].canReply,false);assert.equal(sent[99].canReply,true)
 assert.equal(sent[1].ageSeconds,121)
})

test('long text is bounded without dropping any message, nickname or compact reference',()=>{
 const rows=modelComments(Array.from({length:100},(_,i)=>({id:'long-'+i,nickname:'昵称'+i,content:'长文字'.repeat(200)})))
 fitCommentText(rows,()=>Buffer.byteLength(JSON.stringify(rows))>40000)
 assert.equal(rows.length,100);assert.ok(Buffer.byteLength(JSON.stringify(rows))<=40000)
 assert.ok(rows.every((row,i)=>row.id==='c'+(i+1)&&row.nickname==='昵称'+i&&row.contentTruncated))
})

 test('compact ranges expand to the actual bounded message references',()=>{
 assert.equal(expandCommentIds(['c1-c100']).length,100)
 assert.deepEqual(expandCommentIds(['c3-c5','c4','c9']),['c3','c4','c5','c9'])
 for(const id of ['c0-c100','c1-c101','c9-c2'])assert.throws(()=>expandCommentIds([id]),/范围无效/)
 })
