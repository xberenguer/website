import { md5 } from './vendor/noble/legacy.js';
import { bytesToHex } from './vendor/noble/utils.js';

export const sector = 4096;
export const md5Hex = bytes => bytesToHex(md5(bytes));
export const sha256 = async bytes => bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
export function requireThat(ok, message) { if (!ok) throw new Error(message); }
export const roundUp = value => Math.ceil(value / sector) * sector;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const erased = bytes => bytes.every(b => b === 255);
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
  requireThat(['chip','imageChipId','capacity','mac'].every(k => current[k] === saved[k]), 'The connected device changed. Reconnect the device that owns this backup.');
}
export function permittedRange(device, address, length) {
  if (!integer(address) || !integer(length) || !length || address % sector || length % sector) return false;
  const end = address + length;
  if (end > device.flashBytes) return false;
  return device.id === 'waveshare175c' ? address >= 0x200000 && end <= 0x800000 :
    device.id === 'sticks3' && ((address >= 0 && end <= 0x9000) || (address >= 0xe000 && end <= 0x7f0000));
}
export function validateParts(release, device, files) {
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
  if (device.id === 'waveshare175c') requireThat(parts.length === 1 && parts[0].address === 0x200000 && parts[0].kind === 'application', 'Waveshare requires an application-only image.');
  return parts;
}
export async function fetchFiles(release, fetcher = fetch) {
  const files = new Map();
  for (const file of release.files) {
    requireThat(/^firmware\/[a-zA-Z0-9._-]+\.bin$/.test(file.url), 'Invalid firmware URL.');
    const response = await fetcher(file.url, { cache: 'no-cache' });
    requireThat(response.ok, `Could not download ${file.id}.`);
    const data = new Uint8Array(await response.arrayBuffer());
    requireThat(data.length === file.bytes && await sha256(data) === file.sha256, `Integrity check failed for ${file.id}. No flash was written.`);
    files.set(file.id, data);
  }
  return files;
}

// esptool-js 0.7.1 leaves the stub's final 16-byte READ_FLASH digest in the stream.
// Consume it here before issuing the next command, then verify the whole range too.
export async function readVerified(loader, address, length, progress = () => {}) {
  requireThat(loader.IS_STUB === true && integer(length) && length > 0, 'A running flash stub is required.');
  const result = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 65536) {
    const size = Math.min(65536, length - offset);
    const data = await loader.readFlash(address + offset, size);
    requireThat(data instanceof Uint8Array && data.length === size, 'Incomplete flash backup.');
    const digest = await loader.transport.read(loader.FLASH_READ_TIMEOUT);
    requireThat(digest instanceof Uint8Array && digest.length === 16 && bytesToHex(digest) === md5Hex(data), 'Flash read digest mismatch.');
    result.set(data, offset); progress((offset + size) / length);
  }
  requireThat((await loader.flashMd5sum(address, length)).toLowerCase() === md5Hex(result), 'Device backup verification failed.');
  return result;
}
export async function prepare(loader, release, device, identity, files, progress = () => {}) {
  validateIdentity(identity, device);
  const parts = validateParts(release, device, files);
  progress('Reading partition table',0);
  const table = await readVerified(loader, 0x8000, sector);
  const rows = parsePartitions(table, device.flashBytes);
  const matchingMap = samePartitions(rows, release.partitions);
  if (device.id === 'waveshare175c') requireThat(matchingMap, 'Factory partition map differs. This installer preserves the Waveshare factory layout; use the manual recovery guide.');
  const changed = [];
  for (const part of parts) {
    progress('Comparing '+part.kind,0);
    if ((await loader.flashMd5sum(part.address, part.data.length)).toLowerCase() !== md5Hex(part.data)) changed.push(part);
  }
  const ranges = [];
  for (let i = 0; i < changed.length; i++) {
    const part = changed[i];
    progress(`Backing up ${part.kind}`, i / changed.length);
    const before = await readVerified(loader, part.address, roundUp(part.data.length), p => progress(`Backing up ${part.kind}`, (i+p)/changed.length));
    const after = before.slice(); after.set(part.data);
    ranges.push({ address: part.address, before, after, sha256: await sha256(before), md5: md5Hex(before), kind: part.kind });
  }
  return { identity: { ...identity }, release: release.id, device: device.id, tableSha256: await sha256(table), replacingMap: !matchingMap, ranges };
}

const backupMagic = encoder.encode('BFLASH1\0');
export async function encodeBackup(plan) {
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
  const release = catalog.releases.find(r => r.id === manifest.release && r.device === manifest.device);
  requireThat(manifest.format === 1 && device && release && Array.isArray(manifest.ranges) && manifest.ranges.length > 0 && manifest.ranges.length <= release.parts.length, 'Unsupported recovery file.');
  validateIdentity(manifest.identity, device);
  let at = 12+size; const used = new Set(); const ranges = [];
  for (const r of manifest.ranges) {
    requireThat(integer(r.address) && integer(r.length) && !used.has(r.address) && release.parts.some(p => p.address === r.address && roundUp(p.length) === r.length) && permittedRange(device,r.address,r.length), 'Recovery file requests an unsupported address.');
    used.add(r.address);
    requireThat(at+r.length <= bytes.length, 'Truncated recovery data.');
    const before = bytes.slice(at,at+r.length); at += r.length;
    requireThat(await sha256(before) === r.sha256 && md5Hex(before) === r.md5, 'Recovery data checksum mismatch.');
    ranges.push({ ...r, before });
  }
  requireThat(at === bytes.length, 'Unexpected recovery data.');
  return { ...manifest, ranges };
}

export async function writeRanges(loader, ranges, field, progress = () => {}) {
  requireThat(loader.IS_STUB === true, 'Flash stub is not running.');
  await loader.writeFlash({ fileArray: ranges.map(r => ({ address:r.address, data:r[field] })), flashMode:'keep', flashFreq:'keep', flashSize:'keep', eraseAll:false, compress:true, calculateMD5Hash:md5Hex,
    reportProgress:(i,done,total) => progress((i+done/Math.max(total,1))/ranges.length) });
  for (const r of ranges) requireThat((await loader.flashMd5sum(r.address,r[field].length)).toLowerCase() === md5Hex(r[field]), 'Final flash verification failed.');
}
export async function installTransaction(loader, plan, identify, progress = () => {}) {
  checkSameDevice(await identify(), plan.identity);
  // Detect an unexpected mutation between preparing and writing. No write on failure.
  for (const r of plan.ranges) requireThat((await loader.flashMd5sum(r.address,r.before.length)).toLowerCase() === r.md5, 'Flash changed after backup. Prepare a new installation.');
  const currentTable = await readVerified(loader,0x8000,sector);
  requireThat(await sha256(currentTable) === plan.tableSha256, 'Partition table changed after preparation.');
  try {
    await writeRanges(loader,plan.ranges,'after',p => progress('Installing',p));
    return { installed:true };
  } catch (error) {
    try {
      checkSameDevice(await identify(),plan.identity);
      await writeRanges(loader,plan.ranges,'before',p => progress('Restoring previous firmware',p));
      return { installed:false, restored:true, error };
    } catch {
      throw new Error('Installation stopped and automatic recovery could not be verified. Keep the saved recovery file, reconnect in flashing mode and use Restore backup.');
    }
  }
}
export async function restoreTransaction(loader, plan, device, identify, progress = () => {}) {
  validateIdentity(plan.identity,device);
  checkSameDevice(await identify(),plan.identity);
  requireThat(plan.ranges.length > 0 && plan.ranges.every(r => permittedRange(device,r.address,r.before.length) && md5Hex(r.before) === r.md5), 'Invalid recovery ranges.');
  // The live table may have been interrupted mid-write; never require it to parse here.
  await writeRanges(loader,plan.ranges,'before',progress);
}
