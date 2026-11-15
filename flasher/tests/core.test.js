import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { md5Hex,sha256,parsePartitions,samePartitions,validateIdentity,checkSameDevice,permittedRange,validateParts,fetchFiles,readVerified,prepare,encodeBackup,decodeBackup,installTransaction,restoreTransaction,roundUp } from '../core.js';
const catalog=JSON.parse(await readFile(new URL('../catalog.json',import.meta.url)));
const encoder=new TextEncoder();
const device=catalog.devices[0], release=catalog.releases[0];
const identity={chip:'ESP32-S3',imageChipId:9,capacity:device.flashBytes,mac:'12:34:56:78:9a:bc'};
const fromHex=hex=>Uint8Array.from(hex.match(/../g).map(x=>parseInt(x,16)));
function table(rows,checksum=true){
  const data=new Uint8Array(4096).fill(255),v=new DataView(data.buffer);
  rows.forEach((r,i)=>{const at=i*32;v.setUint16(at,0x50aa,true);data[at+2]=r.type;data[at+3]=r.subtype;v.setUint32(at+4,r.offset,true);v.setUint32(at+8,r.size,true);data.fill(0,at+12,at+28);data.set(encoder.encode(r.label),at+12);v.setUint32(at+28,r.flags,true);});
  if(checksum){const at=rows.length*32;v.setUint16(at,0xebeb,true);data.set(fromHex(md5Hex(data.subarray(0,at))),at+16);}return data;
}
const files=new Map();for(const f of release.files)files.set(f.id,new Uint8Array(await readFile(new URL('../'+f.url,import.meta.url))));
class FakeLoader {
  constructor(){this.memory=new Uint8Array(device.flashBytes).fill(255);this.memory.set(table(release.partitions),0x8000);this.IS_STUB=true;this.FLASH_READ_TIMEOUT=1000;this.writes=[];this.failOnce=false;this.ESP_READ_FLASH=0xd2;this.packets=[];this.transport={read:async()=>this.packets.shift(),write:async()=>{}};}
  async checkCommand(name,op,request){
    assert.equal(op,0xd2);const v=new DataView(request.buffer,request.byteOffset);const at=v.getUint32(0,true),len=v.getUint32(4,true),packet=v.getUint32(8,true);
    const bytes=this.memory.slice(at,at+len);this.packets=[];
    for(let offset=0;offset<len;offset+=packet)this.packets.push(bytes.slice(offset,offset+packet));
    this.packets.push(this.badDigest?new Uint8Array(16):fromHex(md5Hex(bytes)));return 0;
  }
  async flashMd5sum(at,len){return md5Hex(this.memory.subarray(at,at+len));}
  async writeFlash(options){assert.equal(options.eraseAll,false);assert.equal(options.compress,true);assert.equal(options.flashMode,'keep');assert.equal(options.flashFreq,'keep');assert.equal(options.flashSize,'keep');assert.equal(typeof options.calculateMD5Hash,'function');this.writes.push(options.fileArray.map(f=>f.address));
    for(const f of options.fileArray){this.memory.set(f.data,f.address);if(this.failOnce){this.failOnce=false;throw new Error('injected partial write');}}
  }
}
test('MD5 and SHA-256 known vectors, including multi-megabyte byte arrays',async()=>{
  assert.equal(md5Hex(encoder.encode('')),'d41d8cd98f00b204e9800998ecf8427e');assert.equal(md5Hex(encoder.encode('abc')),'900150983cd24fb0d6963f7d28e17f72');
  assert.equal(await sha256(encoder.encode('abc')),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(md5Hex(new Uint8Array(2*1024*1024)), 'b2d1236c286a3c0704224fe4105eca49');
});
test('partition parser handles exact map and clean erased terminators',()=>{
  assert.ok(samePartitions(parsePartitions(table(release.partitions),device.flashBytes),release.partitions));
  assert.ok(samePartitions(parsePartitions(table(release.partitions,false),device.flashBytes),release.partitions));
  assert.equal(samePartitions(release.partitions,[...release.partitions].reverse()),false);
});
test('partition parser rejects corruption, invalid padding, overlap and extra data',()=>{
  for(const mutate of [b=>b[0]=0,b=>b[12]=0,b=>b[18]=65,b=>b[112]^=1,b=>b[127]=0,b=>b[500]=0]){const b=table(release.partitions);mutate(b);assert.throws(()=>parsePartitions(b,device.flashBytes));}
  assert.throws(()=>parsePartitions(new Uint8Array(4000),device.flashBytes));
  const bad=structuredClone(release.partitions);bad[1].offset=bad[0].offset;assert.throws(()=>parsePartitions(table(bad),device.flashBytes));
  bad[1].offset=device.flashBytes;assert.throws(()=>parsePartitions(table(bad),device.flashBytes));
});
test('device checks reject wrong chip, capacity and changed identity',()=>{
  validateIdentity(identity,device);
  assert.throws(()=>validateIdentity({...identity,chip:'ESP32'},device));assert.throws(()=>validateIdentity({...identity,capacity:33554432},device));assert.throws(()=>validateIdentity({...identity,mac:'00:00:00:00:00:00'},device));assert.throws(()=>checkSameDevice({...identity,mac:'12:34:56:78:9a:bd'},identity));
});
test('protected regions, image chip and overlapping payloads are rejected',()=>{
  assert.equal(permittedRange(device,0x9000,4096),false);assert.equal(permittedRange(device,0xe000,4096),true);assert.equal(permittedRange(catalog.devices[1],0,4096),false);
  assert.equal(validateParts(release,device,files).length,4);
  const r=structuredClone(release);r.parts[0].address=0x9000;assert.throws(()=>validateParts(r,device,files));r.parts[0].address=0x8000;assert.throws(()=>validateParts(r,device,files));
  const f=new Map(files);const bytes=files.values().next().value.slice();bytes[12]=0;f.set(release.files[0].id,bytes);assert.throws(()=>validateParts(release,device,f));
});
test('every shipped firmware has exact SHA-256, size, map and permitted offsets',async()=>{
  for(const r of [...catalog.releases,...(catalog.recoveryReleases||[])]){const map=new Map();for(const f of r.files){const bytes=new Uint8Array(await readFile(new URL('../'+f.url,import.meta.url)));assert.equal(bytes.length,f.bytes);assert.equal(await sha256(bytes),f.sha256);map.set(f.id,bytes);}const d=catalog.devices.find(d=>d.id===r.device);const parts=validateParts(r,d,map);const t=parts.find(p=>p.kind==='partitions');if(t)assert.ok(samePartitions(parsePartitions(t.data,d.flashBytes),r.partitions));}
});
test('saved recovery files survive moving an older release out of the current catalog',async()=>{
  const old=catalog.recoveryReleases[0],d=catalog.devices.find(d=>d.id===old.device);
  assert.ok(old&&!catalog.releases.some(r=>r.id===old.id));
  const before=new Uint8Array(roundUp(old.parts[0].length)).fill(71);
  const plan={device:d.id,release:old.id,identity:{...identity,capacity:d.flashBytes},tableSha256:'0'.repeat(64),ranges:[{address:old.parts[0].address,before}]};
  const backup=await encodeBackup(plan);
  assert.deepEqual((await decodeBackup(backup,catalog)).ranges[0].before,before);
  await assert.rejects(decodeBackup(backup,{...catalog,recoveryReleases:[]}),/Unsupported recovery file/);
});
test('download failure, wrong hash and wrong length leave writes unavailable',async()=>{
  await assert.rejects(fetchFiles(release,async()=>({ok:false})),/download/);
  await assert.rejects(fetchFiles(release,async()=>({ok:true,arrayBuffer:async()=>new Uint8Array(100).buffer})),/Integrity/);
  const bytes=files.values().next().value.slice();bytes[100]^=1;await assert.rejects(fetchFiles(release,async()=>({ok:true,arrayBuffer:async()=>bytes.buffer})),/Integrity/);
});
test('flash reads consume and validate each trailing stub digest',async()=>{
  const loader=new FakeLoader();const data=await readVerified(loader,0,131072);assert.equal(data.length,131072);
  loader.badDigest=true;await assert.rejects(readVerified(loader,0,4096),/digest/i);
  loader.IS_STUB=false;await assert.rejects(readVerified(loader,0,4096),/stub/);
});
test('preparation preserves sector tails and backs up only changed ranges',async()=>{
  const loader=new FakeLoader();loader.memory.fill(99,0x10000,0x10000+roundUp(release.parts[3].length));
  const plan=await prepare(loader,release,device,identity,files);assert.equal(loader.writes.length,0);const app=plan.ranges.find(r=>r.address===0x10000);assert.equal(app.after.at(-1),99);
  for(const p of validateParts(release,device,files))loader.memory.set(p.data,p.address);
  assert.equal((await prepare(loader,release,device,identity,files)).ranges.length,0);
});
test('Waveshare refuses a different table before mutation',async()=>{
  const r=catalog.releases[1],d=catalog.devices[1],f=r.files[0];const map=new Map([[f.id,new Uint8Array(await readFile(new URL('../'+f.url,import.meta.url)))]]);const loader=new FakeLoader();
  await assert.rejects(prepare(loader,r,d,{...identity,capacity:d.flashBytes},map),/Factory partition/);assert.equal(loader.writes.length,0);
});
test('private backup roundtrip validates hashes, permitted offsets and trailing bytes',async()=>{
  const loader=new FakeLoader();const plan=await prepare(loader,release,device,identity,files);const bytes=await encodeBackup(plan);const decoded=await decodeBackup(bytes,catalog);assert.deepEqual(decoded.ranges[0].before,plan.ranges[0].before);
  const bad=bytes.slice();bad[bad.length-1]^=1;await assert.rejects(decodeBackup(bad,catalog),/checksum/);await assert.rejects(decodeBackup(new Uint8Array([...bytes,0]),catalog),/Unexpected/);
  const size=new DataView(bytes.buffer).getUint32(8,true);const m=JSON.parse(new TextDecoder().decode(bytes.subarray(12,12+size)));m.ranges[0].address=0x9000;const json=encoder.encode(JSON.stringify(m));const forged=new Uint8Array(12+json.length+bytes.length-12-size);forged.set(bytes.subarray(0,8));new DataView(forged.buffer).setUint32(8,json.length,true);forged.set(json,12);forged.set(bytes.subarray(12+size),12+json.length);await assert.rejects(decodeBackup(forged,catalog),/unsupported address/);
});
test('successful install verifies all ranges and excludes NVS / erase-all',async()=>{
  const loader=new FakeLoader();loader.memory.fill(77,0x9000,0xe000);const plan=await prepare(loader,release,device,identity,files);const result=await installTransaction(loader,plan,async()=>identity);assert.equal(result.installed,true);assert.ok(loader.memory.subarray(0x9000,0xe000).every(b=>b===77));for(const r of plan.ranges)assert.deepEqual(loader.memory.subarray(r.address,r.address+r.after.length),r.after);
});
test('changed MAC, changed flash or changed table stops before any write',async()=>{
  for(const change of ['mac','flash','table']){const loader=new FakeLoader();const plan=await prepare(loader,release,device,identity,files);if(change==='flash')loader.memory[0]^=1;if(change==='table')loader.memory[0x8fff]=0;await assert.rejects(installTransaction(loader,plan,async()=>change==='mac'?{...identity,mac:'12:34:56:78:9a:bd'}:identity));assert.equal(loader.writes.length,0);}
});
test('partial write restores exact old sectors; recovery accepts a damaged live table',async()=>{
  const loader=new FakeLoader();const plan=await prepare(loader,release,device,identity,files);loader.failOnce=true;const result=await installTransaction(loader,plan,async()=>identity);assert.equal(result.restored,true);assert.equal(loader.writes.length,2);for(const r of plan.ranges)assert.deepEqual(loader.memory.subarray(r.address,r.address+r.before.length),r.before);
  const decoded=await decodeBackup(await encodeBackup(plan),catalog);loader.memory.fill(0,0x8000,0x9000);await restoreTransaction(loader,decoded,device,async()=>identity);for(const r of decoded.ranges)assert.deepEqual(loader.memory.subarray(r.address,r.address+r.before.length),r.before);
});
test('disconnected rollback is never reported as verified',async()=>{
  const loader=new FakeLoader();const plan=await prepare(loader,release,device,identity,files);loader.failOnce=true;let calls=0;await assert.rejects(installTransaction(loader,plan,async()=>{if(++calls>1)throw Error('disconnected');return identity;}),/could not be verified/);
});
