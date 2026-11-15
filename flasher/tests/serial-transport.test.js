import test from 'node:test';
import assert from 'node:assert/strict';
import { QueuedTransport } from '../serial-transport.js';
function fakePort(){
  let controller;const stream=new ReadableStream({start(c){controller=c;}});let acquisitions=0;
  const getReader=stream.getReader.bind(stream);stream.getReader=(...args)=>{++acquisitions;return getReader(...args);};
  const writes=[];
  const port={readable:stream,writable:new WritableStream({write(bytes){writes.push(bytes.slice());}}),
    async open(options){this.options=options;},async close(){this.readable=null;this.writable=null;}};
  return {port,writes,controller,get acquisitions(){return acquisitions;}};
}
function joined(frames,t){const all=frames.map(p=>t.slipWriter(p));const bytes=new Uint8Array(all.reduce((n,p)=>n+p.length,0));let at=0;for(const p of all){bytes.set(p,at);at+=p.length;}return bytes;}
test('persistent reader preserves fragmented/coalesced binary packets through one stream lock',async()=>{
 for(const chunk of [63,64,255,512,4096,65536]){
  const fake=fakePort(),t=new QueuedTransport(fake.port);await t.connect(115200,{bufferSize:65536});t.readLoop();
  const packets=Array.from({length:128},(_,i)=>Uint8Array.from({length:512},(_,j)=>(i+j)%256));
  const raw=joined(packets,t);for(let at=0;at<raw.length;at+=chunk)fake.controller.enqueue(raw.slice(at,at+chunk));
  for(const expected of packets)assert.deepEqual(await t.read(2000),expected);
  assert.equal(fake.acquisitions,1);assert.equal(fake.port.readable.locked,true);assert.equal(t.diagnostics().frames,128);
  await t.disconnect();assert.equal(fake.port.readable,null);
 }
});
test('SLIP escape state survives single-byte chunks and empty delimiters',async()=>{
 const fake=fakePort(),t=new QueuedTransport(fake.port);await t.connect(115200);t.readLoop();
 const packets=[new Uint8Array([0xc0,0xdb,0,255]),new Uint8Array([0xdb,0xc0])];
 const raw=joined(packets,t);for(const byte of new Uint8Array([0xc0,...raw,0xc0]))fake.controller.enqueue(new Uint8Array([byte]));
 for(const expected of packets)assert.deepEqual(await t.read(1000),expected);
 assert.equal(t.packets.length,0);await t.disconnect();
});
test('EOF and receive errors reject pending reads immediately and poison that connection',async()=>{
 for(const kind of ['end','overrun']){
  const fake=fakePort(),t=new QueuedTransport(fake.port);await t.connect(115200);t.readLoop();
  const pending=t.read(1000);
  if(kind==='end')fake.controller.close();else fake.controller.error(new DOMException('data lost','BufferOverrunError'));
  await assert.rejects(pending,/USB receive/);await assert.rejects(t.write(new Uint8Array([1])),/USB receive/);
  await t.disconnect();
 }
});
test('partial-frame timeout reports counts and invalidation prevents protocol resumption',async()=>{
 const fake=fakePort(),t=new QueuedTransport(fake.port);await t.connect(115200);t.readLoop();
 fake.controller.enqueue(new Uint8Array([0xc0,1,2,3]));
 await assert.rejects(t.read(30),/partial=3, raw=4/);
 t.invalidate(Error('Reconnect required'));t.flushInput();
 await assert.rejects(t.read(30),/Reconnect required/);await assert.rejects(t.write(new Uint8Array([1])),/Reconnect required/);
 await t.disconnect();
});
test('concurrent reads are rejected without losing the first request',async()=>{
 const fake=fakePort(),t=new QueuedTransport(fake.port);await t.connect(115200);t.readLoop();
 const pending=t.read(1000);await assert.rejects(t.read(1000),/Concurrent USB reads/);
 fake.controller.enqueue(t.slipWriter(new Uint8Array([4,5])));assert.deepEqual(await pending,new Uint8Array([4,5]));await t.disconnect();
});
test('writes escape bytes, release their lock and reject a missing output stream',async()=>{
 const fake=fakePort(),t=new QueuedTransport(fake.port);await t.connect(115200);
 await t.write(new Uint8Array([0xc0,0xdb,7]));assert.deepEqual(fake.writes[0],new Uint8Array([0xc0,0xdb,0xdc,0xdb,0xdd,7,0xc0]));
 assert.equal(fake.port.writable.locked,false);fake.port.writable=null;
 await assert.rejects(t.write(new Uint8Array([1])),/unavailable/);await t.disconnect();
});
test('flush removes queued and partial input; malformed or oversized frames fail closed',async()=>{
 const fake=fakePort(),t=new QueuedTransport(fake.port);await t.connect(115200);t.readLoop();
 t.feed(joined([new Uint8Array([1]),new Uint8Array([2])],t));assert.deepEqual(await t.read(),new Uint8Array([1]));
 t.flushInput();assert.equal(t.inWaiting(),0);assert.equal(t.peek().length,0);
 fake.controller.enqueue(new Uint8Array([0xc0,0xdb,1]));await assert.rejects(t.read(1000),/USB receive failed/);await t.disconnect();
 const other=new QueuedTransport(fakePort().port);assert.throws(()=>other.feed(new Uint8Array([0xc0,...new Uint8Array(65537)])),/too large/);
});
