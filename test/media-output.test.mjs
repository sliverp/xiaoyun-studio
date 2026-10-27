import {test} from 'node:test'
import assert from 'node:assert/strict'
import {OutputGraph,normalizeDestinations,buildEncoderArgs,buildRemuxArgs,SINK_BUFFER_LIMIT} from '../server/media-output.mjs'
const connection=id=>({id,platform:'custom',name:id,rtmpUrl:'rtmps://example.test/live',streamKey:"private'key\\value"})
const graph=()=>new OutputGraph({ffmpeg:'not-spawned',dataDir:'/tmp',getFrame:()=>null})

test('explicit destinations take precedence over legacy output and reject duplicate or excessive connections',()=>{
 assert.deepEqual(normalizeDestinations({destinations:[],rtmpUrl:'rtmp://legacy.test/live',streamKey:'old'}),[])
 assert.equal(normalizeDestinations({rtmpUrl:'rtmp://legacy.test/live',streamKey:'old'})[0].id,'legacy')
 assert.equal(normalizeDestinations({destinations:[connection('one')]})[0].destination,"rtmps://example.test/live/private'key\\value")
 assert.throws(()=>normalizeDestinations({destinations:[connection('one'),connection('one')]}),/唯一/)
 assert.throws(()=>normalizeDestinations({destinations:Array.from({length:9},(_,i)=>connection(String(i)))}),/8/)
 assert.throws(()=>normalizeDestinations({destinations:[{...connection('one'),rtmpUrl:'file:///tmp/output'}]}),/RTMP/)
})
test('platform and recording branches copy one encoded transport without another audio or video encoder',()=>{
 const encoded=buildEncoderArgs({width:640,height:360,fps:10,videoBitrate:'800k',audioBitrate:'96k'})
 assert.equal(encoded.filter(value=>value==='libx264').length,1);assert.equal(encoded.filter(value=>value==='aac').length,1)
 for(const options of [{destination:"rtmps://example.test/live/quote'and\\slash"},{recordPath:"/tmp/record'with|separator.mp4"}]){
  const args=buildRemuxArgs(options);assert.ok(args.includes('copy'));assert.ok(!args.includes('libx264'));assert.ok(!args.includes('aac'));assert.ok(!args.includes('tee'));assert.equal(args.at(-1),options.destination||options.recordPath)
 }
})
test('an overflowing platform is restarted without blocking another platform or the encoder transport',()=>{
 const output=graph(),received=[];let failed=0
 const slow=output.createSink(normalizeDestinations({destinations:[connection('slow')]})[0]),fast=output.createSink(normalizeDestinations({destinations:[connection('fast')]})[0])
 slow.process={stopping:false,reason:'',child:{stdin:{writable:true,writableLength:SINK_BUFFER_LIMIT,write(){assert.fail('overflow must not grow the buffer')}},kill(){failed++}}}
 fast.process={stopping:false,reason:'',child:{stdin:{writable:true,writableLength:0,write(bytes){received.push(bytes);return true}}}}
 output.sinks.set('slow',slow);output.sinks.set('fast',fast);const packet=Buffer.alloc(188)
 output.fanOut(packet);assert.equal(failed,1);assert.deepEqual(received,[packet]);assert.equal(slow.state,'reconnecting');clearTimeout(slow.process.killTimer)
})
test('manual stop cancels independent retry timers and cannot revive stopped destinations',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const output=graph(),sink=output.createSink(normalizeDestinations({destinations:[connection('one')]})[0]);output.sinks.set('one',sink);output.wanted=true
 let starts=0;output.startSink=()=>{starts++}
 assert.equal(output.queueSinkRetry(sink),true);assert.equal(output.status().platforms[0].state,'reconnecting')
 await output.stop();t.mock.timers.tick(10000);assert.equal(starts,0);assert.equal(output.queueSinkRetry(sink),false);assert.equal(output.status().running,false)
})
test('stopping one destination retains another sender and redacts all destinations and keys from status',async()=>{
 const output=graph(),first=output.createSink(normalizeDestinations({destinations:[connection('one')]})[0]),second=output.createSink(normalizeDestinations({destinations:[connection('two')]})[0]);output.sinks.set('one',first);output.sinks.set('two',second);output.wanted=true
 for(const sink of [first,second]){sink.state='streaming';sink.frames=10;sink.process={child:{stdin:{end(){sink.process=null}}},closed:Promise.resolve(),stopping:false}}
 await output.stopDestination('one');const status=output.status();assert.equal(status.platforms[0].active,false);assert.equal(status.platforms[1].active,true);assert.equal(status.running,true)
 assert.doesNotMatch(JSON.stringify(status),/rtmps:|private|key\\|destination|streamKey/)
 output.sinks.clear();output.wanted=false
})
test('retries stop after three consecutive failures until explicitly requested again',()=>{
 const output=graph(),sink=output.createSink(normalizeDestinations({destinations:[connection('one')]})[0]);output.sinks.set('one',sink);output.wanted=true;sink.failures=3
 assert.equal(output.queueSinkRetry(sink),false);assert.equal(sink.state,'error');assert.equal(sink.timer,null)
 output.sinks.clear();output.wanted=false
})
