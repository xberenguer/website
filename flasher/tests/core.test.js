import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { md5Hex,sha256,parsePartitions,samePartitions,validateIdentity,checkSameDevice,permittedRange,validateParts,fetchFiles,readVerified,inspectInstallation,prepare,encodeBackup,decodeBackup,installTransaction,restoreTransaction,roundUp } from '../core.js';
import { validateCatalog } from '../release-status.js';
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
  constructor(d=device,r=release){this.memory=new Uint8Array(d.flashBytes).fill(255);this.memory.set(table(r.partitions),0x8000);this.IS_STUB=true;this.FLASH_READ_TIMEOUT=1000;this.writes=[];this.failOnce=false;this.ESP_READ_FLASH=0xd2;this.packets=[];this.transport={read:async()=>this.packets.shift(),write:async()=>{}};}
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
test('signed Seeder opt-in recognizes the measured Voxel Flight table and backs up only the app',async()=>{
  const ordinary=catalog.releases.find(r=>r.project==='seeder'&&r.device==='waveshare175c');
  const alternate={...ordinary,voxelFlightLayout:true};
  const d=catalog.devices.find(d=>d.id===alternate.device);
  const id={...identity,capacity:d.flashBytes};
  const fixture=structuredClone(catalog);
  fixture.releases[fixture.releases.findIndex(r=>r.id===ordinary.id)]=alternate;
  assert.equal(validateCatalog(fixture),fixture);
  const invalid=structuredClone(fixture);
  invalid.releases.find(r=>r.device==='sticks3').voxelFlightLayout=true;
  assert.throws(()=>validateCatalog(invalid),/Invalid Seeder Voxel Flight/);
  const rows=[
    [1,2,0x9000,0x6000,'nvs'],[1,1,0xf000,0x1000,'phy_init'],
    [0,0,0x10000,0x500000,'factory'],[1,129,0x510000,0x1af0000,'storage']
  ].map(([type,subtype,offset,size,label])=>({type,subtype,offset,size,label,flags:0}));
  const loader=new FakeLoader(d,{partitions:rows});
  const tableHash='71282a988ac14b25b9f7521929a33b6c86cd17f4a70e47b1bc6c34be248f96c8';
  assert.equal(await sha256(loader.memory.subarray(0x8000,0x9000)),tableHash);
  const [f]=alternate.files;
  const data=new Uint8Array(await readFile(new URL('../'+f.url,import.meta.url)));
  const map=new Map([[f.id,data]]);
  await assert.rejects(prepare(loader,ordinary,d,id,map),/Factory partition map differs/);
  loader.memory.set(table(rows,false),0x8000);
  await assert.rejects(prepare(loader,alternate,d,id,map),/Factory partition map differs/);
  loader.memory.set(table(rows),0x8000);
  assert.equal((await inspectInstallation(loader,alternate,d,fixture)).reason,'voxel-flight');
  assert.deepEqual(loader.writes,[]);
  loader.memory.fill(0x5a,0x9000,0x10000);
  loader.memory.fill(0x50,0x10000,0x510000);
  loader.memory[0x510000]=0x51;
  const before=loader.memory.slice();
  const plan=await prepare(loader,alternate,d,id,map,()=>{},()=>{},{backup:false});
  assert.equal(plan.backupCaptured,true);
  assert.equal(plan.replacingMap,false);
  assert.deepEqual(plan.ranges.map(r=>[r.address,r.after.length]),[[0x10000,roundUp(data.length)]]);
  const backup=await encodeBackup(plan);
  await assert.rejects(decodeBackup(backup,catalog),/unsupported address/);
  const decoded=await decodeBackup(backup,fixture);
  const counterfeit={...plan};
  await assert.rejects(installTransaction(loader,counterfeit,async()=>id),/verified Voxel Flight application backup/);
  loader.failOnce=true;
  assert.equal((await installTransaction(loader,plan,async()=>id)).restored,true);
  assert.deepEqual(loader.memory,before);
  assert.equal((await installTransaction(loader,plan,async()=>id)).installed,true);
  assert.deepEqual(loader.memory.subarray(0x10000,0x10000+data.length),data);
  assert.deepEqual(loader.memory.subarray(0,0x10000),before.subarray(0,0x10000));
  assert.deepEqual(loader.memory.subarray(0x10000+data.length),before.subarray(0x10000+data.length));
  loader.memory.set(table(ordinary.partitions),0x8000);
  await assert.rejects(restoreTransaction(loader,decoded,d,async()=>id),/layout changed/);
  loader.memory.set(table(rows),0x8000);
  await restoreTransaction(loader,decoded,d,async()=>id);
  assert.deepEqual(loader.memory,before);
  assert.deepEqual(loader.writes,[[0x10000],[0x10000],[0x10000],[0x10000]]);
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

test('Stopwatch installs only its factory application, preserves sector tail and restores its backup',async()=>{
  const r=catalog.releases.find(r=>r.project==='stopwatch');
  const d=catalog.devices.find(d=>d.id===r.device);
  const file=r.files[0], bytes=new Uint8Array(await readFile(new URL('../'+file.url,import.meta.url)));
  const id={...identity,capacity:d.flashBytes};
  const loader=new FakeLoader(d,r);
  loader.memory.fill(77,0x9000,0x200000);
  loader.memory.fill(99,0x200000,0x200000+roundUp(bytes.length));
  const plan=await prepare(loader,r,d,id,new Map([[file.id,bytes]]));
  assert.equal(plan.ranges.length,1);assert.equal(plan.ranges[0].address,0x200000);
  assert.equal(plan.replacingMap,false);assert.equal(plan.ranges[0].after.at(-1),99);
  const recovery=await decodeBackup(await encodeBackup(plan),catalog);
  const result=await installTransaction(loader,plan,async()=>id);
  assert.equal(result.installed,true);assert.deepEqual(loader.writes,[[0x200000]]);
  assert.deepEqual(loader.memory.subarray(0x200000,0x200000+bytes.length),bytes);
  assert.ok(loader.memory.subarray(0x9000,0x200000).every(x=>x===77));
  await restoreTransaction(loader,recovery,d,async()=>id);
  assert.deepEqual(loader.memory.subarray(0x200000,0x200000+roundUp(bytes.length)),recovery.ranges[0].before);
});

test('live activity separates compressed transfer from final device verification and reports rollback truthfully',async()=>{
 const loader=new FakeLoader();const plan=await prepare(loader,release,device,identity,files);const events=[];
 const write=loader.writeFlash.bind(loader);
 loader.writeFlash=async options=>{for(let i=0;i<options.fileArray.length;i++){options.reportProgress(i,0,100);options.reportProgress(i,50,100);options.reportProgress(i,100,100);}await write(options);};
 const result=await installTransaction(loader,plan,async()=>identity,()=>{},e=>events.push(e));assert.equal(result.installed,true);
 const transfer=events.filter(e=>e.type==='progress'&&e.phase==='write');assert.ok(transfer.some(e=>e.done===50));assert.ok(transfer.every(e=>e.label.includes('compressed')));
 const firstVerification=events.findIndex(e=>e.type==='progress'&&e.phase==='verify');const lastTransfer=events.findLastIndex(e=>e.type==='progress'&&e.phase==='write');assert.ok(firstVerification>lastTransfer);
 const final=events.filter(e=>e.type==='progress'&&e.phase==='verify').at(-1);assert.equal(final.overallDone,final.overallTotal);
 const other=new FakeLoader();const backup=await prepare(other,release,device,identity,files);other.failOnce=true;const recovery=[];assert.equal((await installTransaction(other,backup,async()=>identity,()=>{},e=>recovery.push(e))).restored,true);assert.ok(recovery.some(e=>e.level==='error'));assert.ok(recovery.some(e=>e.type==='progress'&&e.label==='Verifying automatic recovery'));
 const third=new FakeLoader();const p=await prepare(third,release,device,identity,files,()=>{},()=>{throw Error('UI broke');});assert.equal((await installTransaction(third,p,async()=>identity,()=>{},()=>{throw Error('UI broke');})).installed,true);
});

test('optional-backup fast path reads only table/tail sectors, preserves tails and still verifies all writes',async()=>{
 const loader=new FakeLoader();const before=loader.memory.slice();let read=0;const command=loader.checkCommand.bind(loader);
 loader.checkCommand=async(...args)=>{read+=new DataView(args[2].buffer,args[2].byteOffset).getUint32(4,true);return command(...args);};
 const plan=await prepare(loader,release,device,identity,files,()=>{},()=>{},{backup:false});
 assert.equal(plan.backupCaptured,false);assert.ok(plan.ranges.every(r=>r.before===null));assert.ok(read<=4096*(1+plan.ranges.length));assert.ok(read<plan.ranges.reduce((n,r)=>n+r.after.length,0));
 await assert.rejects(encodeBackup(plan),/Create a recovery backup/);
 assert.equal((await installTransaction(loader,plan,async()=>identity)).installed,true);
 for(const r of plan.ranges){const part=release.parts.find(p=>p.address===r.address);assert.deepEqual(loader.memory.subarray(r.address+part.length,r.address+r.after.length),before.subarray(r.address+part.length,r.address+r.after.length));}
 assert.deepEqual(loader.memory.subarray(0x9000,0xe000),before.subarray(0x9000,0xe000));
});
test('fast path retains mutation guards and never attempts fictional rollback without a backup',async()=>{
 const loader=new FakeLoader();const plan=await prepare(loader,release,device,identity,files,()=>{},()=>{},{backup:false});loader.memory[plan.ranges[0].address]^=1;
 await assert.rejects(installTransaction(loader,plan,async()=>identity),/Flash changed after preparation/);assert.equal(loader.writes.length,0);
 const failing=new FakeLoader();const fast=await prepare(failing,release,device,identity,files,()=>{},()=>{},{backup:false});failing.failOnce=true;const events=[];
 await assert.rejects(installTransaction(failing,fast,async()=>identity,()=>{},e=>events.push(e)),/without a recovery backup/);assert.equal(failing.writes.length,1);assert.ok(events.some(e=>e.message?.includes('No recovery backup')));assert.equal(events.some(e=>e.phase==='rollback'),false);
});
test('backup recommendations distinguish same family, another app, unknown firmware and layout change',async()=>{
 const loader=new FakeLoader();const address=release.parts.find(p=>p.kind==='application').address;
 const header=name=>{loader.memory[address]=0xe9;loader.memory.set(fromHex('3254cdab'),address+32);loader.memory.fill(0,address+80,address+112);loader.memory.set(encoder.encode(name),address+80);};
 header('arduino-lib-builder');const same=await inspectInstallation(loader,release,device,catalog);assert.equal(same.reason,null);assert.equal(same.currentProject,'seeder');
 header('stopwatch-firmware');assert.equal((await inspectInstallation(loader,release,device,catalog)).reason,'project');
 header('custom-app');assert.equal((await inspectInstallation(loader,release,device,catalog)).reason,'unknown');
 const bj=catalog.releases.find(r=>r.project==='blackjack');assert.equal((await inspectInstallation(loader,bj,device,catalog)).reason,'layout');assert.equal(loader.writes.length,0);
});
