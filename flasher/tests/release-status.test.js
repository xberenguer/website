import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateCatalog, validateReleaseStatus, describeReleaseStatus, fetchReleaseStatus, pinRelease } from '../release-status.js';
import { loadSignedCatalog } from '../signing.js';

const catalog=JSON.parse(await readFile(new URL('../catalog.json',import.meta.url)));
const clone=()=>structuredClone(catalog);
const release=catalog.releases[0];
const now=Date.parse('2026-11-17T12:00:00Z');
const status=()=>({checkedAt:new Date(now).toISOString(),projects:[{
  project:release.project,repository:'xberenguer/Seeder-Fork',tag:'v2.2.0',
  releaseUrl:'https://github.com/xberenguer/Seeder-Fork/releases/tag/v2.2.0',
  state:'current',message:'Published release assets verified.',
  devices:[{device:release.device,offeredVersion:release.version}]
}]});

test('current and archived catalog contracts are valid',()=>assert.equal(validateCatalog(catalog),catalog));
test('catalog rejects duplicate IDs, duplicate current slots, unknown references and invalid versions',()=>{
  for(const change of [
    j=>j.projects.push({...j.projects[0]}),
    j=>j.releases.push({...j.releases[0],id:'duplicate-slot'}),
    j=>j.releases[0].device='unknown',
    j=>j.releases[0].project='unknown',
    j=>j.releases[0].version='latest',
    j=>j.recoveryReleases.push({...j.releases[0]}),
  ]){const j=clone();change(j);assert.throws(()=>validateCatalog(j));}
});
test('catalog rejects unsafe provenance, filenames, board contracts and part ranges',()=>{
  for(const change of [
    j=>j.releases[0].source='javascript:alert(1)',
    j=>j.releases[0].manual='http://example.com/manual',
    j=>j.releases[0].files[0].url='firmware/../unexpected.bin',
    j=>j.releases[0].files[0].sha256='wrong',
    j=>j.releases[0].files[0].bytes=-1,
    j=>j.releases[0].parts[0].sourceOffset=999999999,
    j=>j.releases[0].parts[0].address=0x9000,
    j=>j.devices[0].flashBytes=1024,
    j=>j.devices[0].viewBox='0 0 Infinity 0',
    j=>j.otherProjects[0].url='data:text/html,bad',
  ]){const j=clone();change(j);assert.throws(()=>validateCatalog(j));}
});

test('atomic envelope verifies exact signed bytes and never fetches separate mutable files',async()=>{
  const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
  const key=Buffer.from(await crypto.subtle.exportKey('raw',pair.publicKey)).toString('hex');
  const bytes=new TextEncoder().encode(JSON.stringify(catalog));
  const sig=new Uint8Array(await crypto.subtle.sign('Ed25519',pair.privateKey,bytes));
  const envelope={format:1,catalog:Buffer.from(bytes).toString('base64'),signature:Buffer.from(sig).toString('base64')};
  const calls=[];
  const fetcher=async(url,options)=>{calls.push(url);assert.equal(options.cache,'no-store');return {ok:true,json:async()=>envelope};};
  assert.deepEqual(await loadSignedCatalog(fetcher,key),catalog);
  assert.deepEqual(calls,['catalog.signed.json']);
  envelope.signature=Buffer.from(new Uint8Array(64)).toString('base64');
  await assert.rejects(loadSignedCatalog(fetcher,key),/does not match/);
  envelope.catalog='!invalid!';
  await assert.rejects(loadSignedCatalog(fetcher,key),/encoding/);
  await assert.rejects(loadSignedCatalog(async()=>({ok:false}),key),/Installation is disabled/);
});
test('a valid signature does not bypass catalog schema validation',async()=>{
  const pair=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
  const key=Buffer.from(await crypto.subtle.exportKey('raw',pair.publicKey)).toString('hex');
  const malformed=clone();malformed.releases[0].version='latest';
  const bytes=new TextEncoder().encode(JSON.stringify(malformed));
  const sig=await crypto.subtle.sign('Ed25519',pair.privateKey,bytes);
  const envelope={format:1,catalog:Buffer.from(bytes).toString('base64'),signature:Buffer.from(sig).toString('base64')};
  await assert.rejects(loadSignedCatalog(async()=>({ok:true,json:async()=>envelope}),key),/version/);
});

test('fresh status identifies a matching release without changing signed selection',()=>{
  const j=status();assert.equal(validateReleaseStatus(j),j);
  const result=describeReleaseStatus(j,release,now);
  assert.equal(result.state,'current');assert.match(result.message,/Release sync checked/);
  j.projects[0].state='blocked';j.projects[0].message='New release is missing its Waveshare asset.';
  assert.match(describeReleaseStatus(j,release,now).message,/Release sync blocked/);
  assert.equal(release.version,catalog.releases[0].version);
});
test('missing, stale, future, malformed or mismatched status never claims current',async()=>{
  assert.equal(describeReleaseStatus(null,release,now).state,'unavailable');
  for(const change of [
    j=>j.checkedAt=new Date(now-46*60000).toISOString(),
    j=>j.checkedAt=new Date(now+3600000).toISOString(),
    j=>j.projects[0].devices[0].offeredVersion='0.0.0',
    j=>j.projects=[],
  ]){const j=status();change(j);assert.equal(describeReleaseStatus(j,release,now).state,'unavailable');}
  const bad=status();bad.projects[0].releaseUrl='https://evil.example/releases/anything';
  assert.throws(()=>validateReleaseStatus(bad));
  assert.equal(await fetchReleaseStatus(async()=>({ok:false})),null);
  assert.equal(await fetchReleaseStatus(async()=>({ok:true,json:async()=>bad})),null);
});
test('an opened installer pins an immutable release even when the catalog changes',()=>{
  const mutable=structuredClone(release), pinned=pinRelease(mutable);
  mutable.version='99.99.99';mutable.files[0].sha256='0'.repeat(64);
  assert.equal(pinned.version,release.version);assert.equal(pinned.files[0].sha256,release.files[0].sha256);
  assert.throws(()=>{pinned.files[0].url='firmware/other.bin';},TypeError);
});
