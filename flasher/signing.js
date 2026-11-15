import { requireThat } from './core.js';
export const TRUSTED_RELEASE_KEY = '044b1a970af958277f4a742b0f4544526406ac99e00575d25f5bbf0b17b28a7a';
export const RELEASE_KEY_FINGERPRINT = '34568ae48435426bb68028eb6f3bb338a2cba5115c906a33ca26c3592c31c5d4';
const hexBytes = hex => Uint8Array.from(hex.match(/../g).map(b => parseInt(b,16)));
export async function verifySignedCatalog(bytes, signature, trustedKey = TRUSTED_RELEASE_KEY) {
  requireThat(bytes instanceof Uint8Array && signature instanceof Uint8Array && signature.length === 64, 'Missing or invalid release signature. Installation is disabled.');
  let key;
  try { key = await crypto.subtle.importKey('raw',hexBytes(trustedKey),{name:'Ed25519'},false,['verify']); }
  catch { throw new Error('This browser cannot verify Ed25519 releases. Use an up-to-date desktop Chrome/Edge or the independent terminal guide.'); }
  requireThat(await crypto.subtle.verify('Ed25519',key,signature,bytes),'Release signature does not match the trusted key. Installation is disabled.');
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
