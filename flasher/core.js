import { observe, hexAddress } from './events.js';
import { validateBlackjack, isBlackjack, isBlackjackStick, blackjackInitializations, recoveryAuthority } from './blackjack.js';
import { readFlashFramed } from './flash-read.js';
import { md5 } from './vendor/noble/legacy.js';
import { bytesToHex } from './vendor/noble/utils.js';

export const sector = 4096;
export const md5Hex = bytes => bytesToHex(md5(bytes));
export const sha256 = async bytes => bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
export function requireThat(ok, message) { if (!ok) throw new Error(message); }
export const roundUp = value => Math.ceil(value / sector) * sector;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const erased = bytes => bytes.every(b => b === 255);
const recoveryAuthorities = new WeakMap();
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function parsePartitions(bytes, capacity) {
  requireThat(bytes instanceof Uint8Array && bytes.length === sector, 'Incomplete partition table.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const rows = []; let ended = false;
  for (let at = 0; at < bytes.length; at += 32) {
    const magic = view.getUint16(at, true);
    if (magic === 0xffff) {
      requireThat(erased(bytes.subarray(at)), 'Unexpected data after partition terminator.');
      ended = true; break;
    }
    if (magic === 0xebeb) {
      requireThat(erased(bytes.subarray(at + 2, at + 16)), 'Invalid partition checksum record.');
      requireThat(bytesToHex(bytes.subarray(at + 16, at + 32)) === md5Hex(bytes.subarray(0, at)), 'Partition checksum mismatch.');
      requireThat(erased(bytes.subarray(at + 32)), 'Unexpected data after partition checksum.');
      ended = true; break;
    }
    requireThat(magic === 0x50aa, 'Unrecognized partition table.');
    const labelBytes = bytes.subarray(at + 12, at + 28);
    const zero = labelBytes.indexOf(0);
    const name = zero < 0 ? labelBytes : labelBytes.subarray(0, zero);
    requireThat(name.length > 0 && name.every(b => b >= 32 && b <= 126), 'Invalid partition label.');
    requireThat(zero < 0 || labelBytes.subarray(zero).every(b => b === 0), 'Invalid partition label padding.');
    const row = { type: bytes[at + 2], subtype: bytes[at + 3], offset: view.getUint32(at + 4, true), size: view.getUint32(at + 8, true), label: decoder.decode(name), flags: view.getUint32(at + 28, true) };
    requireThat(row.offset >= 0x9000 && row.size > 0 && row.offset + row.size <= capacity, 'Partition outside flash capacity.');
    requireThat(row.offset % sector === 0 && row.size % sector === 0, 'Unaligned partition.');
    requireThat(!rows.some(r => r.label === row.label || (row.offset < r.offset + r.size && r.offset < row.offset + row.size)), 'Duplicate or overlapping partitions.');
    rows.push(row);
  }
  requireThat(ended && rows.length > 0, 'Missing partition table terminator.');
  return rows;
}
export function samePartitions(actual, expected) {
  return actual.length === expected.length && actual.every((row, i) => ['type','subtype','offset','size','label','flags'].every(k => row[k] === expected[i][k]));
}
export function validateIdentity(identity, device) {
  requireThat(identity.chip === 'ESP32-S3' && identity.imageChipId === 9, 'Only ESP32-S3 is supported.');
  requireThat(identity.capacity === device.flashBytes, 'Flash capacity does not match this device. Check the selected model.');
  requireThat(/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(identity.mac) && identity.mac !== '00:00:00:00:00:00' && identity.mac !== 'ff:ff:ff:ff:ff:ff', 'Could not identify the connected device.');
}
export function checkSameDevice(current, saved) {
  requireThat(['chip','imageChipId','capacity','mac'].every(k => current[k] === saved[k]), 'The connected device changed. Reconnect the device used for this operation.');
}
export function permittedRange(device, address, length) {
  if (!integer(address) || !integer(length) || !length || address % sector || length % sector) return false;
  const end = address + length;
  if (end > device.flashBytes) return false;
  return device.id === 'waveshare175c' ? address >= 0x200000 && end <= 0x800000 :
    device.id === 'sticks3' && ((address >= 0 && end <= 0x9000) || (address >= 0xe000 && end <= 0x7f0000));
}
export function validateParts(release, device, files) {
  validateBlackjack(release, device, files);
  requireThat(release.device === device.id, 'Release and device do not match.');
  const parts = release.parts.map(p => {
    const source = files.get(p.file);
    requireThat(source instanceof Uint8Array && integer(p.sourceOffset) && integer(p.length) && p.length > 0 && p.sourceOffset + p.length <= source.length, 'Invalid firmware slice.');
    requireThat(permittedRange(device, p.address, roundUp(p.length)), 'Firmware would touch a protected or unsupported region.');
    const data = source.slice(p.sourceOffset, p.sourceOffset + p.length);
    if (p.kind === 'application' || p.kind === 'bootloader') {
      requireThat(data.length > 256 && data[0] === 0xe9 && data[12] === 9 && data[13] === 0, 'Firmware is not an ESP32-S3 application/bootloader.');
    }
    return { ...p, data };
  });
  const sorted = [...parts].sort((a,b) => a.address - b.address);
  requireThat(sorted.every((p,i) => !i || p.address >= sorted[i-1].address + roundUp(sorted[i-1].length)), 'Firmware slices overlap.');
  if (isBlackjackStick(release)) requireThat(samePartitions(parsePartitions(parts.find(p => p.kind === 'partitions').data,device.flashBytes),release.partitions), 'Blackjack binary partition table differs.');
  if (device.id === 'waveshare175c') requireThat(parts.length === 1 && parts[0].address === 0x200000 && parts[0].kind === 'application', 'Waveshare requires an application-only image.');
  return parts;
}
export async function fetchFiles(release, fetcher = fetch, notify = () => {}, listener = () => {}) {
  const files = new Map();
  const totalBytes=release.files.reduce((n,f)=>n+f.bytes,0);let completed=0;
  for (const file of release.files) {
    requireThat(/^firmware\/[a-zA-Z0-9._-]+\.bin$/.test(file.url), 'Invalid firmware URL.');
    requireThat(integer(file.bytes) && file.bytes>0,'Invalid firmware length.');
    notify('Downloading firmware',file.id);
    observe(listener,{type:'log',source:'DOWNLOAD',message:`GET ${file.url} · ${file.bytes} bytes expected`});
    const update=done=>observe(listener,{type:'progress',phase:'download',label:'Downloading firmware',id:file.id,done,total:file.bytes,overallDone:completed+done,overallTotal:totalBytes});
    update(0);
    const response = await fetcher(file.url, { cache: 'no-store', signal: AbortSignal.timeout(60000) });
    requireThat(response.ok, `Could not download ${file.id}.`);
    notify('Reading download',file.id);
    let data;
    if(response.body?.getReader){
      const reader=response.body.getReader();data=new Uint8Array(file.bytes);let offset=0;
      try {
        for(;;){const {done,value}=await reader.read();if(done)break;
          requireThat(value instanceof Uint8Array && offset+value.length<=file.bytes,`Integrity check failed for ${file.id}: download exceeds signed length. No flash was written.`);
          data.set(value,offset);offset+=value.length;update(offset);
        }
        requireThat(offset===file.bytes,`Integrity check failed for ${file.id}: incomplete download. No flash was written.`);
      }catch(error){try{await reader.cancel();}catch{}throw error;}finally{reader.releaseLock();}
    }else{data=new Uint8Array(await response.arrayBuffer());update(data.length);}
    notify('Checking download SHA-256',file.id);
    observe(listener,{type:'progress',phase:'check',label:'Checking download SHA-256'});
    const digest=await sha256(data);
    requireThat(data.length === file.bytes && digest === file.sha256, `Integrity check failed for ${file.id}. No flash was written.`);
    observe(listener,{type:'log',source:'VERIFY',level:'success',message:`SHA-256 OK · ${file.id} · ${digest}`});
    files.set(file.id, data);completed+=data.length;
  }
  return files;
}

// The framed reader owns every cumulative ACK and the trailing stub digest.
// Verify the complete assembled range once more with the device MD5 command.
export async function readVerified(loader, address, length, progress = () => {}, listener = () => {}) {
  requireThat(loader.IS_STUB === true && integer(length) && length > 0, 'A running flash stub is required.');
  observe(listener,{type:'log',source:'READ',message:`Reading ${hexAddress(address)} · ${length} bytes`});
  const result = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 65536) {
    const size = Math.min(65536, length - offset);
    const data=await readFlashFramed(loader,address+offset,size,{
      // Even a fully escaped payload stays below 512 wire bytes on native USB.
      md5Hex,packetSize:128,maxInflight:1,
      onStage:s=>{if(s.stage==='ack')progress((offset+s.received)/length);}
    });
    result.set(data, offset); progress((offset + size) / length);
  }
  requireThat((await loader.flashMd5sum(address, length)).toLowerCase() === md5Hex(result), 'Device read verification failed.');
  observe(listener,{type:'log',source:'VERIFY',level:'success',message:`Read MD5 OK · ${hexAddress(address)} · ${length} bytes`});
  return result;
}
// Metadata is a backup recommendation only; it never grants write authority.
export async function inspectInstallation(loader, release, device, catalog, listener = () => {}) {
  const table=await readVerified(loader,0x8000,sector,()=>{},listener);
  const rows=parsePartitions(table,device.flashBytes);const matchingMap=samePartitions(rows,release.partitions);
  let currentProject=null;
  if(matchingMap){
    const app=release.parts.find(p=>p.kind==='application');
    const header=await readVerified(loader,app.address,sector,()=>{},listener);
    if(header[0]===0xe9&&bytesToHex(header.subarray(32,36))==='3254cdab'){
      const raw=header.subarray(80,112);const end=raw.indexOf(0);const name=raw.subarray(0,end<0?raw.length:end);
      if(name.every(b=>b>=32&&b<=126)){
        const projectName=decoder.decode(name);
        if(['stardust-sticks3','stardust-waveshare175c'].includes(projectName))currentProject='blackjack';
        else if(projectName==='stopwatch-firmware')currentProject='stopwatch';
        else if(projectName==='arduino-lib-builder'){
          const candidates=new Set(catalog.releases.filter(r=>r.device===device.id&&['seeder','phoenix'].includes(r.project)&&samePartitions(rows,r.partitions)).map(r=>r.project));
          if(candidates.size===1)currentProject=[...candidates][0];
        }
      }
    }
  }
  const reason=!matchingMap?'layout':currentProject&&currentProject!==release.project?'project':!currentProject?'unknown':null;
  return {matchingMap,currentProject,reason,tableSha256:await sha256(table)};
}

export async function prepare(loader, release, device, identity, files, progress = () => {}, listener = () => {}, options = { backup: true }) {
  validateIdentity(identity, device);
  let parts = validateParts(release, device, files);
  progress('Reading partition table',0);
  observe(listener,{type:'progress',phase:'check',label:'Reading partition table'});
  const table = await readVerified(loader, 0x8000, sector,()=>{},listener);
  const rows = parsePartitions(table, device.flashBytes);
  const matchingMap = samePartitions(rows, release.partitions);
  observe(listener,{type:'log',source:'CHECK',message:`Partition table checked · ${matchingMap?'matching layout':'layout replacement required'}`});
  if (device.id === 'waveshare175c') requireThat(matchingMap, 'Factory partition map differs. This installer preserves the Waveshare factory layout; use the manual recovery guide.');
  if (isBlackjack(release)) {
    parts = matchingMap ? parts.filter(p => p.kind === 'application') : [...parts,...blackjackInitializations(release,rows)];
    requireThat(!rows.filter(r => r.type === 1 && r.subtype === 2).some(r => parts.some(p => p.address < r.offset+r.size && r.offset < p.address+roundUp(p.length))), 'Blackjack installation would overlap existing NVS. Use manual recovery.');
  }
  const changed = [];
  for (const part of parts) {
    progress('Comparing '+part.kind,0);
    const differs=(await loader.flashMd5sum(part.address, part.data.length)).toLowerCase() !== md5Hex(part.data);
    if(differs)changed.push(part);
    observe(listener,{type:'log',source:'CHECK',message:`${part.kind} @ ${hexAddress(part.address)} · ${part.data.length} bytes · ${differs?'update required':'already matches; skipped'}`});
  }
  const ranges = [];const captureBackup=options.backup!==false;
  const backupBytes=changed.reduce((n,p)=>n+roundUp(p.data.length),0);let backedUp=0;
  for (let i = 0; i < changed.length; i++) {
    const part = changed[i];const length=roundUp(part.data.length);
    let before=null,after,md5;
    if(captureBackup){
      progress(`Backing up ${part.kind}`, i / changed.length);
      before=await readVerified(loader,part.address,length,p=>{progress(`Backing up ${part.kind}`,(i+p)/changed.length);observe(listener,{type:'progress',phase:'backup',label:'Preparing recovery backup',id:`${part.kind} @ ${hexAddress(part.address)}`,done:Math.round(p*length),total:length,overallDone:backedUp+Math.round(p*length),overallTotal:backupBytes});},listener);
      backedUp+=length;after=before.slice();md5=md5Hex(before);
    }else{
      observe(listener,{type:'progress',phase:'check',label:'Checking flash ranges'});
      md5=(await loader.flashMd5sum(part.address,length)).toLowerCase();
      requireThat(/^[0-9a-f]{32}$/.test(md5),'Device range digest is invalid.');
      after=new Uint8Array(length);
      // Preserve the untouched tail with one sector read, not a full-app backup.
      const used=part.data.length%sector;
      if(used){const tail=await readVerified(loader,part.address+length-sector,sector,()=>{},listener);after.set(tail.subarray(used),part.data.length);}
      observe(listener,{type:'log',source:'CHECK',message:`Range checked without recovery backup · ${part.kind} @ ${hexAddress(part.address)} · ${length} bytes`});
    }
    after.set(part.data);
    ranges.push({address:part.address,before,after,...(before?{sha256:await sha256(before)}:{}),md5,kind:part.kind});
  }
  const plan = { identity: { ...identity }, release: release.id, device: device.id, tableSha256: await sha256(table), replacingMap: !matchingMap, backupCaptured:captureBackup, ranges };
  recoveryAuthorities.set(plan, recoveryAuthority(release,device));
  observe(listener,{type:'log',source:captureBackup?'BACKUP':'CHECK',level:'success',message:captureBackup?`${ranges.length} changed ranges backed up and verified · ${backupBytes} bytes. No flash written.`:`${ranges.length} changed ranges checked. Recovery backup skipped; no flash written.`});
  return plan;
}

const backupMagic = encoder.encode('BFLASH1\0');
export async function encodeBackup(plan) {
  requireThat(plan.ranges.length>0&&plan.ranges.every(r=>r.before instanceof Uint8Array),'Create a recovery backup first.');
  const ranges = [];
  for (const range of plan.ranges) ranges.push({ address: range.address, length: range.before.length, sha256: await sha256(range.before), md5: md5Hex(range.before) });
  const manifest = encoder.encode(JSON.stringify({ format:1, device:plan.device, release:plan.release, identity:plan.identity, tableSha256:plan.tableSha256, ranges }));
  const bytes = new Uint8Array(12 + manifest.length + ranges.reduce((n,r) => n + r.length, 0));
  bytes.set(backupMagic); new DataView(bytes.buffer).setUint32(8, manifest.length, true); bytes.set(manifest, 12);
  let at = 12 + manifest.length;
  for (const range of plan.ranges) { bytes.set(range.before, at); at += range.before.length; }
  return bytes;
}
export async function decodeBackup(bytes, catalog) {
  requireThat(bytes instanceof Uint8Array && bytes.length >= 12 && bytesToHex(bytes.subarray(0,8)) === bytesToHex(backupMagic), 'Not a flasher recovery file.');
  const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8,true);
  requireThat(size > 0 && size <= 65536 && 12+size < bytes.length, 'Invalid recovery manifest.');
  const manifest = JSON.parse(decoder.decode(bytes.subarray(12,12+size)));
  const device = catalog.devices.find(d => d.id === manifest.device);
  // A saved recovery file must remain usable after its release leaves the UI.
  const release = [...catalog.releases, ...(catalog.recoveryReleases || [])]
    .find(r => r.id === manifest.release && r.device === manifest.device);
  const authority = release && device ? recoveryAuthority(release,device) : [];
  requireThat(manifest.format === 1 && device && release && Array.isArray(manifest.ranges) && manifest.ranges.length > 0 && manifest.ranges.length <= authority.length, 'Unsupported recovery file.');
  validateIdentity(manifest.identity, device);
  let at = 12+size; const used = new Set(); const ranges = [];
  for (const r of manifest.ranges) {
    requireThat(integer(r.address) && integer(r.length) && !used.has(r.address) && authority.some(p => p.address === r.address && p.length === r.length) && (permittedRange(device,r.address,r.length) || (isBlackjackStick(release) && r.address === 0x7f0000 && r.length === 0x2000)), 'Recovery file requests an unsupported address.');
    used.add(r.address);
    requireThat(at+r.length <= bytes.length, 'Truncated recovery data.');
    const before = bytes.slice(at,at+r.length); at += r.length;
    requireThat(await sha256(before) === r.sha256 && md5Hex(before) === r.md5, 'Recovery data checksum mismatch.');
    ranges.push({ ...r, before });
  }
  requireThat(at === bytes.length, 'Unexpected recovery data.');
  const plan = { ...manifest, ranges };
  recoveryAuthorities.set(plan,authority);
  return plan;
}

export async function writeRanges(loader, ranges, field, progress = () => {}, listener = () => {}, phase = 'write') {
  requireThat(loader.IS_STUB === true, 'Flash stub is not running.');
  const totalBytes=ranges.reduce((n,r)=>n+r[field].length,0);const offsets=[];let previous=0;
  for(const r of ranges){offsets.push(previous);previous+=r[field].length;observe(listener,{type:'log',source:'FLASH',message:`${phase==='rollback'?'Rollback':phase==='restore'?'Restore':'Write'} ${r.kind||'range'} @ ${hexAddress(r.address)} · ${r[field].length} bytes`});}
  await loader.writeFlash({ fileArray: ranges.map(r => ({ address:r.address, data:r[field] })), flashMode:'keep', flashFreq:'keep', flashSize:'keep', eraseAll:false, compress:true, calculateMD5Hash:md5Hex,
    reportProgress:(i,done,total) => {
      const fraction=Math.max(0,Math.min(1,done/Math.max(total,1)));progress((i+fraction)/ranges.length);
      const r=ranges[i];if(!r)return;
      observe(listener,{type:'progress',phase,label:phase==='rollback'?'Restoring previous firmware':phase==='restore'?'Restoring recovery backup':'Writing flash · compressed transfer',id:`${r.kind||'range'} @ ${hexAddress(r.address)}`,done,total,overallDone:offsets[i]+fraction*r[field].length,overallTotal:totalBytes});
    } });
  let verified=0;
  for (const r of ranges) {
    const id=`${r.kind||'range'} @ ${hexAddress(r.address)}`;
    observe(listener,{type:'progress',phase:'verify',label:phase==='rollback'?'Verifying automatic recovery':phase==='restore'?'Verifying restored flash':'Verifying written flash',id,done:0,total:1,unit:'ranges',overallDone:verified,overallTotal:totalBytes});
    requireThat((await loader.flashMd5sum(r.address,r[field].length)).toLowerCase() === md5Hex(r[field]), 'Final flash verification failed.');
    verified+=r[field].length;
    observe(listener,{type:'log',source:'VERIFY',level:'success',message:`Flash MD5 OK · ${hexAddress(r.address)} · ${r[field].length} bytes`});
    observe(listener,{type:'progress',phase:'verify',label:phase==='rollback'?'Verifying automatic recovery':phase==='restore'?'Verifying restored flash':'Verifying written flash',id,done:1,total:1,unit:'ranges',overallDone:verified,overallTotal:totalBytes});
  }
}
export async function installTransaction(loader, plan, identify, progress = () => {}, listener = () => {}) {
  observe(listener,{type:'progress',phase:'check',label:'Rechecking device and flash before writing'});
  checkSameDevice(await identify(), plan.identity);
  // Detect an unexpected mutation between preparing and writing. No write on failure.
  for (const r of plan.ranges) requireThat((await loader.flashMd5sum(r.address,r.after.length)).toLowerCase() === r.md5, 'Flash changed after preparation. Prepare a new installation.');
  const currentTable = await readVerified(loader,0x8000,sector,()=>{},listener);
  requireThat(await sha256(currentTable) === plan.tableSha256, 'Partition table changed after preparation.');
  observe(listener,{type:'log',source:'CHECK',level:'success',message:'Same device, prepared ranges and partition table verified. Starting bounded writes.'});
  try {
    await writeRanges(loader,plan.ranges,'after',p => progress('Installing',p),listener);
    return { installed:true };
  } catch (error) {
    const recoverable=plan.ranges.every(r=>r.before instanceof Uint8Array);
    observe(listener,{type:'log',source:'FLASH',level:'error',message:`Install failed: ${error.message}. ${recoverable?'Attempting automatic recovery.':'No recovery backup was prepared.'}`});
    if(!recoverable)throw new Error('Installation stopped without a recovery backup. Reconnect in flashing mode and retry the installation. '+error.message);
    try {
      checkSameDevice(await identify(),plan.identity);
      await writeRanges(loader,plan.ranges,'before',p => progress('Restoring previous firmware',p),listener,'rollback');
      return { installed:false, restored:true, error };
    } catch {
      throw new Error('Installation stopped and automatic recovery could not be verified. Keep the saved recovery file, reconnect in flashing mode and use Restore backup.');
    }
  }
}
export async function restoreTransaction(loader, plan, device, identify, progress = () => {}, listener = () => {}) {
  validateIdentity(plan.identity,device);
  checkSameDevice(await identify(),plan.identity);
  requireThat(plan.ranges.length > 0 && plan.ranges.every(r => recoveryAuthorities.get(plan)?.some(p => p.address === r.address && p.length === r.before.length) && (permittedRange(device,r.address,r.before.length) || (device.id === 'sticks3' && recoveryAuthorities.get(plan)?.some(p => p.address === r.address && p.length === r.before.length) && r.address === 0x7f0000 && r.before.length === 0x2000)) && md5Hex(r.before) === r.md5), 'Invalid recovery ranges.');
  observe(listener,{type:'log',source:'CHECK',level:'success',message:'Recovery identity, range authority and backup checksums accepted.'});
  // The live table may have been interrupted mid-write; never require it to parse here.
  await writeRanges(loader,plan.ranges,'before',progress,listener,'restore');
}
