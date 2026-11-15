import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { configureFlash, readFlashFramed } from '../flash-read.js';
const md5Hex = bytes => createHash('md5').update(bytes).digest('hex');
const words = bytes => Array.from({ length:bytes.length/4 }, (_,i) => new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(i*4,true));
function fakeRead(payload, packetSize=512) {
  const packets=[];const calls=[];const stages=[];
  for(let i=0;i<payload.length;i+=packetSize)packets.push(payload.slice(i,i+packetSize));
  packets.push(new Uint8Array(createHash('md5').update(payload).digest()));
  return {
    calls,packets,stages,IS_STUB:true,ESP_READ_FLASH:0xd2,FLASH_READ_TIMEOUT:20000,
    async checkCommand(name,op,bytes){calls.push({name,op,words:words(bytes)});return 0;},
    transport:{async read(){return packets.shift();},async write(bytes){calls.push({ack:words(bytes)[0]});}},
  };
}
test('flash configuration sets RAM parameters without writing flash',async()=>{
 for(const capacity of [0x800000,0x2000000]){
  const loader=fakeRead(new Uint8Array(0));await configureFlash(loader,capacity);
  assert.deepEqual(loader.calls,[{name:'configure flash',op:0x0b,words:[0,capacity,65536,4096,256,65535]}]);
 }
});
test('bounded binary reads ACK cumulative lengths and consume exactly one final digest',async()=>{
 const payload=Uint8Array.from({length:1093},(_,i)=>i%256);
 const loader=fakeRead(payload);
 const actual=await readFlashFramed(loader,0x8000,payload.length,{md5Hex,packetSize:512,onStage:s=>loader.stages.push(s)});
 assert.deepEqual(actual,payload);
 assert.deepEqual(loader.calls[0],{name:'read flash',op:0xd2,words:[0x8000,1093,512,64]});
 assert.deepEqual(loader.calls.slice(1),[{ack:512},{ack:1024},{ack:1093}]);
 assert.equal(loader.packets.length,0);assert.equal(loader.stages.at(-1).stage,'verified');
});
test('short data, wrong digest, missing data and command errors fail with their phase',async()=>{
 const payload=new Uint8Array(1024);let loader=fakeRead(payload);
 loader.packets[0]=new Uint8Array(511);
 await assert.rejects(readFlashFramed(loader,0x8000,1024,{md5Hex,packetSize:512}),/data failed \(0\/1024 bytes\)/);
 loader=fakeRead(payload);loader.packets.at(-1)[0]^=1;
 await assert.rejects(readFlashFramed(loader,0x8000,1024,{md5Hex,packetSize:512}),/digest failed \(1024\/1024 bytes\)/);
 loader=fakeRead(payload);loader.transport.read=async()=>{throw Error('timeout');};
 await assert.rejects(readFlashFramed(loader,0x8000,1024,{md5Hex,packetSize:512}),/data failed \(0\/1024 bytes\)/);
 loader=fakeRead(payload);loader.checkCommand=async()=>{throw Error('timeout');};
 await assert.rejects(readFlashFramed(loader,0x8000,1024,{md5Hex,packetSize:512}),/command failed \(0\/1024 bytes\)/);
});
test('invalid read/configuration parameters are rejected before any command',async()=>{
 const loader=fakeRead(new Uint8Array(0));
 for(const [address,length,opts] of [[-1,4096,{}],[0,0,{}],[0xffffffff,2,{}],[0,4,{packetSize:4097}],[0,4,{maxInflight:0}],[0,4,{maxInflight:65}]]){
  await assert.rejects(readFlashFramed(loader,address,length,{md5Hex,...opts}),/Invalid verified flash read/);
 }
 for(const size of [0,-1,2**32,NaN])await assert.rejects(configureFlash(loader,size),/Unsupported flash configuration/);
 loader.IS_STUB=false;
 await assert.rejects(readFlashFramed(loader,0,4,{md5Hex}),/Invalid verified flash read/);
 assert.deepEqual(loader.calls,[]);
});
