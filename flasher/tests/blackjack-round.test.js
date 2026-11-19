import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BLACKJACK_WAVESHARE_CONTRACT,BLACKJACK_WAVESHARE_PARTITIONS as rows,BLACKJACK_WAVESHARE_MAX_APP,blackjackWaveshareParts,blackjackInitializations,recoveryAuthority} from '../blackjack.js';
import {validateCatalog} from '../release-status.js';
import {md5Hex,sha256,validateParts,prepare,encodeBackup,decodeBackup,installTransaction,restoreTransaction} from '../core.js';
const base=JSON.parse(await readFile(new URL('../catalog.json',import.meta.url)));
const device=base.devices.find(d=>d.id==='waveshare175c');
const identity={chip:'ESP32-S3',imageChipId:9,capacity:device.flashBytes,mac:'12:34:56:78:9a:bc'};
const hex=s=>Uint8Array.from(s.match(/../g).map(x=>parseInt(x,16)));
function table(rs){const b=new Uint8Array(4096).fill(255),v=new DataView(b.buffer);rs.forEach((r,i)=>{const at=i*32;v.setUint16(at,0x50aa,true);b[at+2]=r.type;b[at+3]=r.subtype;v.setUint32(at+4,r.offset,true);v.setUint32(at+8,r.size,true);b.fill(0,at+12,at+28);b.set(new TextEncoder().encode(r.label),at+12);v.setUint32(at+28,r.flags,true);});const at=rs.length*32;v.setUint16(at,0xebeb,true);b.set(hex(md5Hex(b.subarray(0,at))),at+16);return b;}
const name='blackjack-waveshare175c-0.12.0-app.bin';
const app=new Uint8Array(529);app[0]=0xe9;app[3]=5<<4;app[12]=9;app.set(hex('3254cdab'),32);app.set(new TextEncoder().encode('0.12.0'),48);
const files=new Map([[name,app]]);
const release={id:'blackjack-waveshare175c-0.12.0',project:'blackjack',device:device.id,version:'0.12.0',contract:BLACKJACK_WAVESHARE_CONTRACT,status:'Preview',description:'Synthetic round test',qualification:'Synthetic offline fixture only',source:'https://github.com/xberenguer/blackjack-trainer',manual:'https://github.com/xberenguer/blackjack-trainer',files:[{id:name,url:'firmware/'+name,bytes:app.length,sha256:await sha256(app)}],parts:blackjackWaveshareParts(name,app.length),partitions:rows};
const catalog={...base,releases:[...base.releases.filter(r=>!(r.project==='blackjack'&&r.device==='waveshare175c')),release]};
class Loader {
 constructor(rs=rows){this.memory=new Uint8Array(device.flashBytes).fill(77);this.memory.set(table(rs),0x8000);this.IS_STUB=true;this.ESP_READ_FLASH=0xd2;this.writes=[];this.reads=[];this.packets=[];this.transport={read:async()=>this.packets.shift(),write:async()=>{}};}
 async checkCommand(_,op,r){assert.equal(op,0xd2);const v=new DataView(r.buffer,r.byteOffset);const at=v.getUint32(0,true),n=v.getUint32(4,true),size=v.getUint32(8,true),b=this.memory.slice(at,at+n);this.reads.push([at,n]);this.packets=[];for(let i=0;i<n;i+=size)this.packets.push(b.slice(i,i+size));this.packets.push(hex(md5Hex(b)));return 0;}
 async flashMd5sum(a,n){return md5Hex(this.memory.subarray(a,a+n));}
 async writeFlash(o){assert.equal(o.eraseAll,false);assert.equal(o.flashSize,'keep');this.writes.push(o.fileArray.map(r=>r.address));for(const r of o.fileArray)this.memory.set(r.data,r.address);}
}
test('round Blackjack is a separate one-file factory contract without journal authority',()=>{
 validateCatalog(catalog);assert.equal(validateParts(release,device,files).length,1);
 assert.deepEqual(blackjackInitializations(release,[]),[]);
 assert.deepEqual(recoveryAuthority(release,device),[{address:0x200000,length:4096}]);
 for(const change of [r=>r.contract='blackjack-sticks3-v1',r=>r.parts[0].address=0x10000,r=>r.parts.push({...r.parts[0],address:0x770000}),r=>r.files[0].bytes=BLACKJACK_WAVESHARE_MAX_APP+1,r=>r.partitions[5].size-=4096,r=>r.project='seeder']){
  const r=structuredClone(release);change(r);assert.throws(()=>validateParts(r,device,files));
 }
 const wrong=app.slice();wrong[3]=3<<4;assert.throws(()=>validateParts(release,device,new Map([[name,wrong]])),/32 MiB/);
});
test('round fast path preserves factory data, sector tails and private journals without reading them',async()=>{
 const loader=new Loader();const before=loader.memory.slice();const plan=await prepare(loader,release,device,identity,files,()=>{},()=>{},{backup:false});
 assert.deepEqual(plan.ranges.map(r=>r.address),[0x200000]);assert.equal(plan.replacingMap,false);assert.equal(plan.backupCaptured,false);
 assert.ok(loader.reads.every(([at,n])=>at+n<=0x770000));
 await installTransaction(loader,plan,async()=>identity);assert.deepEqual(loader.writes,[[0x200000]]);
 assert.deepEqual(loader.memory.subarray(0,0x200000),before.subarray(0,0x200000));
 assert.deepEqual(loader.memory.subarray(0x200000+app.length),before.subarray(0x200000+app.length));
});
test('round optional recovery includes its application only and rejects forged private-journal restores',async()=>{
 const loader=new Loader();const before=loader.memory.slice(0x200000,0x201000);const plan=await prepare(loader,release,device,identity,files);const backup=await encodeBackup(plan);const decoded=await decodeBackup(backup,catalog);
 await installTransaction(loader,plan,async()=>identity);await restoreTransaction(loader,decoded,device,async()=>identity);assert.deepEqual(loader.memory.subarray(0x200000,0x201000),before);
 for(const address of [0x770000,0x7f0000]){
  const fake={identity,device:device.id,release:release.id,ranges:[{address,before:new Uint8Array(8192),md5:md5Hex(new Uint8Array(8192))}],recoveryAuthority:[{address,length:8192}]};
  await assert.rejects(restoreTransaction(loader,fake,device,async()=>identity),/Invalid recovery/);
  const forged=await encodeBackup(fake);await assert.rejects(decodeBackup(forged,catalog),/unsupported address/);
 }
});
test('round refuses different factory map before any write or private data read',async()=>{
 const different=structuredClone(rows);different[5].size-=4096;const loader=new Loader(different);
 await assert.rejects(prepare(loader,release,device,identity,files),/Factory partition map differs/);assert.deepEqual(loader.writes,[]);assert.deepEqual(loader.reads,[[0x8000,4096]]);
});
