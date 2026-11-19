import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BLACKJACK_PARTITIONS as rows,blackjackParts,BLACKJACK_CONTRACT} from '../blackjack.js';
import {validateCatalog} from '../release-status.js';
import {md5Hex,sha256,roundUp,validateParts,prepare,encodeBackup,decodeBackup,installTransaction,restoreTransaction,permittedRange} from '../core.js';
const base=JSON.parse(await readFile(new URL('../catalog.json',import.meta.url)));
// The fixture must remain isolated after a real Blackjack release is offered.
base.projects=base.projects.filter(p=>p.id!=='blackjack');
base.releases=base.releases.filter(r=>r.project!=='blackjack');
base.recoveryReleases=(base.recoveryReleases||[]).filter(r=>r.project!=='blackjack');
const d=base.devices.find(d=>d.id==='sticks3');
const identity={chip:'ESP32-S3',imageChipId:9,capacity:0x800000,mac:'12:34:56:78:9a:bc'};
const hex=s=>Uint8Array.from(s.match(/../g).map(x=>parseInt(x,16)));
function table(rs){const b=new Uint8Array(4096).fill(255),v=new DataView(b.buffer);rs.forEach((r,i)=>{const o=i*32;v.setUint16(o,0x50aa,true);b[o+2]=r.type;b[o+3]=r.subtype;v.setUint32(o+4,r.offset,true);v.setUint32(o+8,r.size,true);b.fill(0,o+12,o+28);b.set(new TextEncoder().encode(r.label),o+12);v.setUint32(o+28,r.flags,true);});const o=rs.length*32;v.setUint16(o,0xebeb,true);b.set(hex(md5Hex(b.subarray(0,o))),o+16);return b;}
const app=new Uint8Array(529).fill(0);app[0]=0xe9;app[12]=9;app.set(hex('3254cdab'),32);app.set(new TextEncoder().encode('0.11.3'),48);
const merged=new Uint8Array(0x10000+app.length).fill(255);merged[0]=0xe9;merged[12]=9;merged[13]=0;merged.set(table(rows),0x8000);merged.set(app,0x10000);
const names=['blackjack-sticks3-0.11.3-app.bin','blackjack-sticks3-0.11.3-install.bin'];
const files=new Map([[names[0],app],[names[1],merged]]);
const release={id:'blackjack-sticks3-0.11.3',project:'blackjack',device:'sticks3',version:'0.11.3',contract:BLACKJACK_CONTRACT,status:'Preview',description:'Synthetic test',qualification:'Synthetic offline fixture only',source:'https://github.com/xberenguer/blackjack-trainer',manual:'https://github.com/xberenguer/blackjack-trainer',files:await Promise.all(names.map(async n=>({id:n,url:'firmware/'+n,bytes:files.get(n).length,sha256:await sha256(files.get(n))}))),parts:blackjackParts(...names,app.length),partitions:rows};
const catalog={...base,projects:[...base.projects,{id:'blackjack',name:'Blackjack Trainer',category:'Training'}],releases:[...base.releases,release]};
class Loader {
 constructor(rs=rows){this.memory=new Uint8Array(0x800000).fill(77);this.memory.set(table(rs),0x8000);this.IS_STUB=true;this.ESP_READ_FLASH=0xd2;this.writes=[];this.packets=[];this.transport={read:async()=>this.packets.shift(),write:async()=>{}};}
 async checkCommand(_,op,r){assert.equal(op,0xd2);const v=new DataView(r.buffer,r.byteOffset);const at=v.getUint32(0,true),n=v.getUint32(4,true),size=v.getUint32(8,true),b=this.memory.slice(at,at+n);this.packets=[];for(let i=0;i<n;i+=size)this.packets.push(b.slice(i,i+size));this.packets.push(hex(md5Hex(b)));return 0;}
 async flashMd5sum(a,n){return md5Hex(this.memory.subarray(a,a+n));}
 async writeFlash(o){assert.equal(o.eraseAll,false);assert.equal(o.flashSize,'keep');this.writes.push(o.fileArray.map(r=>r.address));for(const r of o.fileArray){this.memory.set(r.data,r.address);if(this.fail){this.fail=false;throw Error('interrupted');}}}
}
test('Blackjack exact signed profile rejects changed maps, slices, files and versions',()=>{
 validateCatalog(catalog);assert.equal(validateParts(release,d,files).length,4);assert.equal(permittedRange(d,0x7f0000,0x2000),false);
 for(const fn of [r=>r.contract='other',r=>r.parts[0].length--,r=>r.partitions[5].size*=2,r=>r.files.pop(),r=>r.project='phoenix']){const r=structuredClone(release);fn(r);assert.throws(()=>validateParts(r,d,files));}
 const bad=new Map(files);const b=merged.slice();b[0x10000+500]^=1;bad.set(names[1],b);assert.throws(()=>validateParts(release,d,bad),/differ/);
 const wrong=merged.slice();const foreign=structuredClone(rows);foreign[5].subtype=99;wrong.set(table(foreign),0x8000);bad.set(names[1],wrong);assert.throws(()=>validateParts(release,d,bad),/partition table differs/);
});
test('exact map update writes app only, does not read either private journal, preserves NVS/tails',async()=>{
 const l=new Loader();const old=l.memory.slice();const reads=[];const read=l.checkCommand.bind(l);l.checkCommand=async(...args)=>{reads.push(new DataView(args[2].buffer).getUint32(0,true));return read(...args);};
 const p=await prepare(l,release,d,identity,files);assert.deepEqual(p.ranges.map(r=>r.address),[0x10000]);assert.equal(p.replacingMap,false);assert.ok(reads.every(a=>a<0x770000));
 await installTransaction(l,p,async()=>identity);assert.deepEqual(l.memory.slice(0x9000,0xe000),old.slice(0x9000,0xe000));assert.deepEqual(l.memory.slice(0x770000),old.slice(0x770000));assert.equal(l.memory[0x10000+app.length],77);
});
test('foreign migration backs up both new journals; recovery survives damaged table and restores every sector',async()=>{
 const l=new Loader(base.releases.find(r=>r.device==='sticks3').partitions);const before=l.memory.slice();const p=await prepare(l,release,d,identity,files);assert.ok(p.replacingMap);assert.deepEqual(p.ranges.map(r=>r.address),[0,0x8000,0xe000,0x10000,0x770000,0x7f0000]);
 const backup=await encodeBackup(p);const saved=await decodeBackup(backup,catalog);await installTransaction(l,p,async()=>identity);assert.ok(l.memory.slice(0x770000,0x7f2000).every(x=>x===255));assert.deepEqual(l.memory.slice(0x9000,0xe000),before.slice(0x9000,0xe000));
 l.memory.fill(0,0x8000,0x9000);await restoreTransaction(l,saved,d,async()=>identity);assert.deepEqual(l.memory,before);
});
test('migration preserves compatible public journal independently of newly claimed private journal',async()=>{
 const old=rows.slice(0,3).concat([{...rows[3],size:0x1e0000}],rows.slice(5));const l=new Loader(old);const publicBefore=l.memory.slice(0x7f0000,0x7f2000);const p=await prepare(l,release,d,identity,files);
 assert.ok(p.ranges.some(r=>r.address===0x770000));assert.ok(!p.ranges.some(r=>r.address===0x7f0000));await installTransaction(l,p,async()=>identity);assert.deepEqual(l.memory.slice(0x7f0000,0x7f2000),publicBefore);
});
test('journal typed identity must match, not just label/address; foreign NVS overlap stops without writing',async()=>{
 for(const field of ['type','subtype','flags','label']){const old=structuredClone(rows);old[5][field]=field==='label'?'not-rustsave':99;const l=new Loader(old);const p=await prepare(l,release,d,identity,files);assert.ok(p.ranges.some(r=>r.address===0x7f0000));assert.ok(!p.ranges.some(r=>r.address===0x770000));}
 const old=structuredClone(rows);old[4].type=1;old[4].subtype=2;const l=new Loader(old);await assert.rejects(prepare(l,release,d,identity,files),/NVS/);assert.equal(l.writes.length,0);
});
test('interrupted migration rolls back journals too; untrusted backup cannot extend authority',async()=>{
 const l=new Loader(base.releases.find(r=>r.device==='sticks3').partitions);const before=l.memory.slice();const p=await prepare(l,release,d,identity,files);l.fail=true;const result=await installTransaction(l,p,async()=>identity);assert.equal(result.restored,true);assert.deepEqual(l.memory,before);
 const fake={identity,ranges:[{address:0x7f0000,before:new Uint8Array(0x2000),md5:md5Hex(new Uint8Array(0x2000))}],recoveryAuthority:[{address:0x7f0000,length:0x2000}]};await assert.rejects(restoreTransaction(l,fake,d,async()=>identity),/Invalid recovery/);
});

test('optional-backup migration initializes only declared new journals and keeps NVS without capturing prior payloads',async()=>{
 const l=new Loader(base.releases.find(r=>r.device==='sticks3').partitions);const before=l.memory.slice();
 const p=await prepare(l,release,d,identity,files,()=>{},()=>{},{backup:false});assert.equal(p.replacingMap,true);assert.ok(p.ranges.every(r=>r.before===null));
 await assert.rejects(encodeBackup(p),/Create a recovery backup/);assert.equal((await installTransaction(l,p,async()=>identity)).installed,true);
 assert.deepEqual(l.memory.slice(0x9000,0xe000),before.slice(0x9000,0xe000));assert.ok(l.memory.slice(0x770000,0x7f2000).every(x=>x===255));
});
