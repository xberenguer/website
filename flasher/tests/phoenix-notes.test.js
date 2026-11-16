import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {phoenixNotes,renderPhoenixNotes}from '../phoenix-notes.js';
import {encodeBackup,decodeBackup,roundUp}from '../core.js';
const catalog=JSON.parse(await readFile(new URL('../catalog.json',import.meta.url)));
test('Phoenix notes derive version and qualification from the supplied verified catalog',()=>{
 const r=catalog.releases.find(r=>r.project==='phoenix');const n=phoenixNotes(catalog);assert.equal(n.title,'Phoenix Link · '+r.version);assert.equal(n.qualification,r.qualification);
 const changed=structuredClone(catalog);changed.releases.find(r=>r.project==='phoenix').version='0.2.110';assert.equal(phoenixNotes(changed).title,'Phoenix Link · 0.2.110');
});
test('notes use text content, keep missing Phoenix local and do not request GitHub',()=>{
 const nodes=new Map(['phoenix-summary','phoenix-release-note','phoenix-manual','phoenix-source'].map(k=>[k,{set innerHTML(_){throw Error('HTML interpolation forbidden');}}]));const doc={getElementById:id=>nodes.get(id)};
 const c=structuredClone(catalog);c.releases.find(r=>r.project==='phoenix').qualification='<img src=x>';renderPhoenixNotes(c,doc);assert.equal(nodes.get('phoenix-release-note').textContent,'<img src=x>');
 c.releases=c.releases.filter(r=>r.project!=='phoenix');renderPhoenixNotes(c,doc);assert.equal(nodes.get('phoenix-manual').hidden,true);assert.equal(nodes.get('phoenix-source').hidden,true);
});
test('old Phoenix recovery file remains usable after its exact contract is archived',async()=>{
 const old=catalog.releases.find(r=>r.project==='phoenix'),device=catalog.devices.find(d=>d.id===old.device);const c=structuredClone(catalog);c.releases=c.releases.filter(r=>r.id!==old.id);c.recoveryReleases.push(structuredClone(old));
 const part=old.parts[0];const before=new Uint8Array(roundUp(part.length)).fill(23);const bytes=await encodeBackup({release:old.id,device:old.device,identity:{chip:'ESP32-S3',imageChipId:9,capacity:device.flashBytes,mac:'12:34:56:78:9a:bc'},tableSha256:'0'.repeat(64),ranges:[{address:part.address,before}]});
 assert.deepEqual((await decodeBackup(bytes,c)).ranges[0].before,before);await assert.rejects(decodeBackup(bytes,{...c,recoveryReleases:c.recoveryReleases.filter(r=>r.id!==old.id)}));
});
