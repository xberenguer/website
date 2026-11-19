import test from 'node:test';
import assert from 'node:assert/strict';
import {ActivityLog,cleanText,observe} from '../activity.js';
import {fetchFiles,sha256} from '../core.js';
test('console preserves text as text, strips terminal control codes and device addresses, bounds retained history',()=>{
 let now=1000;const log=new ActivityLog({now:()=>now,limit:3});
 log.terminal('Connecting');log.terminal('...\nChip: ESP32-S3\n');now+=1500;log.add('\x1b[31m<script>hello</script> aa:bb:cc:dd:ee:ff\x1b[0m');
 assert.match(log.text(),/Connecting\.\.\./);assert.match(log.text(),/001\.500s/);assert.match(log.text(),/<script>hello<\/script> \[device address\]/);assert.doesNotMatch(log.text(),/\x1b|aa:bb/);
 log.add('next');assert.equal(log.lines.length,3);assert.equal(log.dropped,1);log.terminal('x'.repeat(10000));assert.equal(log.pending.length,4096);log.flush();assert.equal(log.lines.length,3);
 log.reset();assert.equal(log.text(),'');assert.equal(cleanText('\x00A\rB'),'A\nB');
});
test('diagnostic listeners cannot interrupt installation work',()=>{assert.doesNotThrow(()=>observe(()=>{throw Error('broken console');},{type:'log'}));});
const fixture=async()=>{const a=new Uint8Array([1,2,3,4]),b=new Uint8Array([5,6]);return {data:[a,b],release:{files:await Promise.all([a,b].map(async(bytes,i)=>({id:`unit${i}.bin`,url:`firmware/unit${i}.bin`,bytes:bytes.length,sha256:await sha256(bytes)})))}};};
test('streamed download reports actual file and overall bytes and hashes only complete signed files',async()=>{
 const {data,release}=await fixture();let file=0;const events=[];
 const result=await fetchFiles(release,async()=>{const bytes=data[file++];return new Response(new ReadableStream({start(c){c.enqueue(bytes.slice(0,1));c.enqueue(bytes.slice(1));c.close();}}));},()=>{},e=>events.push(e));
 assert.equal(result.size,2);assert.deepEqual([...result.get('unit0.bin')],[1,2,3,4]);
 const progress=events.filter(e=>e.type==='progress'&&e.phase==='download');assert.deepEqual(progress.map(e=>e.overallDone),[0,1,4,4,5,6]);assert.ok(progress.every(e=>e.overallTotal===6));
 assert.equal(events.filter(e=>e.source==='VERIFY'&&e.level==='success').length,2);
});
test('oversized, short, corrupted and failed downloads never claim successful verification',async()=>{
 const {release}=await fixture();const single={files:[release.files[0]]};
 for(const bytes of [new Uint8Array([1,2,3,4,5]),new Uint8Array([1]),new Uint8Array([1,2,3,9])]){
  const events=[];await assert.rejects(fetchFiles(single,async()=>new Response(bytes),()=>{},e=>events.push(e)),/Integrity/);assert.equal(events.some(e=>e.level==='success'),false);
 }
 await assert.rejects(fetchFiles(single,async()=>new Response('',{status:503})),/Could not download/);
 const result=await fetchFiles(single,async()=>new Response(new Uint8Array([1,2,3,4])),()=>{},()=>{throw Error('UI failed');});assert.equal(result.size,1);
});
