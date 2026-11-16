import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifySignedCatalog, TRUSTED_RELEASE_KEY, RELEASE_KEY_FINGERPRINT } from '../signing.js';
import { sha256 } from '../core.js';
const catalog=new Uint8Array(await readFile(new URL('../catalog.json',import.meta.url)));
const signature=new Uint8Array(await readFile(new URL('../catalog.sig',import.meta.url)));
test('published catalog signature verifies against pinned release key',async()=>{
  const result=await verifySignedCatalog(catalog,signature);assert.equal(result.format,1);assert.ok(result.releases.some(r=>r.project==='stopwatch'));assert.ok(result.releases.length>=4);
  const key=Uint8Array.from(TRUSTED_RELEASE_KEY.match(/../g).map(x=>parseInt(x,16)));assert.equal(await sha256(key),RELEASE_KEY_FINGERPRINT);
});
test('modified catalog, corrupted/missing signature or different signer fails closed',async()=>{
  const corrupt=catalog.slice();corrupt[40]^=1;await assert.rejects(verifySignedCatalog(corrupt,signature),/does not match/);
  const bad=signature.slice();bad[0]^=1;await assert.rejects(verifySignedCatalog(catalog,bad),/does not match/);
  await assert.rejects(verifySignedCatalog(catalog,new Uint8Array(0)),/Missing or invalid/);
  const other=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);const forged=new Uint8Array(await crypto.subtle.sign('Ed25519',other.privateKey,catalog));await assert.rejects(verifySignedCatalog(catalog,forged),/does not match/);
});
