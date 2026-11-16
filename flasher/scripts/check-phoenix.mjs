// Read-only bridge to the current flasher's actual signature/partition contract.
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicKey, createHash } from 'node:crypto';
const [root,operation,...args]=process.argv.slice(2);
const {parsePartitions,samePartitions,validateParts,sha256,requireThat}=await import(pathToFileURL(path.join(root,'core.js')));
const {verifySignedCatalog,RELEASE_KEY_FINGERPRINT}=await import(pathToFileURL(path.join(root,'signing.js')));
const fingerprint='34568ae48435426bb68028eb6f3bb338a2cba5115c906a33ca26c3592c31c5d4';
const bytes=async name=>new Uint8Array(await readFile(name));
const catalogBytes=await bytes(path.join(root,'catalog.json'));
const catalog=await verifySignedCatalog(catalogBytes,await bytes(path.join(root,'catalog.sig')));
requireThat(RELEASE_KEY_FINGERPRINT===fingerprint,'Unexpected release trust key');
const pem=createPublicKey(await readFile(path.join(root,'release-key.pem'))).export({type:'spki',format:'der'});
requireThat(createHash('sha256').update(pem.subarray(-32)).digest('hex')===fingerprint,'Published PEM/key pin mismatch');
const device=catalog.devices.find(d=>d.id==='sticks3');
requireThat(device?.flashBytes===0x800000,'Unexpected StickS3 capacity');
async function validate(release,files){
 const d=catalog.devices.find(d=>d.id===release.device);const parts=validateParts(release,d,files);const table=parts.find(p=>p.kind==='partitions');
 if(table)requireThat(samePartitions(parsePartitions(table.data,d.flashBytes),release.partitions),'Firmware/catalog partition mismatch');
 return parts;
}
if(operation==='existing'){
 const dir=await lstat(path.join(root,'firmware'));requireThat(dir.isDirectory()&&!dir.isSymbolicLink(),'Firmware directory must not be a symlink');let filesCount=0;
 for(const r of [...catalog.releases,...(catalog.recoveryReleases||[])]){
  const files=new Map();for(const f of r.files){requireThat(/^firmware\/[A-Za-z0-9._-]+\.bin$/.test(f.url),'Unsafe existing firmware filename');const p=path.join(root,f.url);const stat=await lstat(p);requireThat(stat.isFile()&&!stat.isSymbolicLink(),'Firmware must be a regular file');const data=await bytes(p);requireThat(data.length===f.bytes&&await sha256(data)===f.sha256,'Existing firmware integrity mismatch');files.set(f.id,data);filesCount++;}await validate(r,files);
 }
 console.log(JSON.stringify({status:'SIGNED_EXISTING_CATALOG_AND_ALL_RELEASES_VALID',files:filesCount,keyFingerprint:fingerprint,catalogSHA256:await sha256(catalogBytes)}));
}else if(operation==='incoming'){
 const release=JSON.parse(await readFile(args[0],'utf8'));const files=new Map([[release.parts.find(p=>p.kind==='application').file,await bytes(args[1])],[release.parts.find(p=>p.kind==='assets').file,await bytes(args[2])]]);const parts=await validate(release,files);
 requireThat(release.project==='phoenix'&&release.device==='sticks3'&&parts.length===5,'Unexpected incoming release contract');
 console.log(JSON.stringify({status:'PASS_ACTUAL_CORE_IMAGE_PARTS_AND_8MB_MAP',parts:parts.length,applicationBytes:parts.find(p=>p.kind==='application').length,assetBytes:parts.find(p=>p.kind==='assets').length}));
}else throw Error('Unknown read-only validation operation');
