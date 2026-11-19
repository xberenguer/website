// A separate signed-release authority. Generic installer permissions stay unchanged.
export const BLACKJACK_CONTRACT = 'blackjack-sticks3-v1';
export const BLACKJACK_WAVESHARE_CONTRACT = 'blackjack-waveshare175c-v1';
export const BLACKJACK_WAVESHARE_MAX_APP = 0x570000;
export const BLACKJACK_PARTITIONS = Object.freeze([
  [1,2,0x9000,0x5000,'nvs'], [1,0,0xe000,0x2000,'otadata'],
  [0,16,0x10000,0x600000,'app0'], [1,130,0x610000,0x160000,'reserved'],
  [1,65,0x770000,0x80000,'rustresume'], [1,64,0x7f0000,0x2000,'rustsave']
].map(([type,subtype,offset,size,label]) => Object.freeze({type,subtype,offset,size,label,flags:0})));
export const BLACKJACK_WAVESHARE_PARTITIONS = Object.freeze([{"type":1,"subtype":2,"offset":36864,"size":204800,"label":"nvsfactory","flags":0},{"type":1,"subtype":2,"offset":241664,"size":860160,"label":"nvs","flags":0},{"type":1,"subtype":0,"offset":1101824,"size":8192,"label":"otadata","flags":0},{"type":1,"subtype":1,"offset":1110016,"size":4096,"label":"phy_init","flags":0},{"type":1,"subtype":130,"offset":1114112,"size":983040,"label":"model","flags":0},{"type":0,"subtype":0,"offset":2097152,"size":6291456,"label":"factory","flags":0},{"type":1,"subtype":130,"offset":8388608,"size":8388608,"label":"storage","flags":0}].map(Object.freeze));
const keys = ['type','subtype','offset','size','label','flags'];
export const sameRow = (a,b) => keys.every(k => a[k] === b[k]);
const fail = (ok,message) => { if (!ok) throw Error(message); };
export const isBlackjack = release => release.project === 'blackjack';
export const isBlackjackStick = release => isBlackjack(release) && release.device === 'sticks3';
export function blackjackWaveshareParts(app, length) {
  return [{file:app,sourceOffset:0,length,address:0x200000,kind:'application'}];
}
export function blackjackParts(app, install, length) {
  return [[install,0,0x8000,0,'bootloader'],[install,0x8000,0x1000,0x8000,'partitions'],[install,0xe000,0x2000,0xe000,'ota'],[app,0,length,0x10000,'application']]
    .map(([file,sourceOffset,length,address,kind]) => ({file,sourceOffset,length,address,kind}));
}
export function validateBlackjack(release, device, files) {
  if (!isBlackjack(release)) { fail(![BLACKJACK_CONTRACT,BLACKJACK_WAVESHARE_CONTRACT].includes(release.contract),'Blackjack contract belongs to Blackjack only.'); return; }
  fail(/^\d+\.\d+\.\d+$/.test(release.version),'Invalid Blackjack stable version.');
  if (release.device === 'waveshare175c') {
    fail(device.id === 'waveshare175c' && device.flashBytes === 0x2000000 && release.contract === BLACKJACK_WAVESHARE_CONTRACT,'Unsupported Blackjack Waveshare device contract.');
    const app = `blackjack-waveshare175c-${release.version}-app.bin`, a = release.files.find(f => f.id === app);
    fail(release.files.length === 1 && a && a.bytes > 256 && a.bytes <= BLACKJACK_WAVESHARE_MAX_APP,'Invalid Blackjack Waveshare application contract.');
    const expected = blackjackWaveshareParts(app,a.bytes);
    fail(Array.isArray(release.parts) && release.parts.length === 1 && Object.keys(release.parts[0]).length === 5 && Object.keys(expected[0]).every(k => release.parts[0][k] === expected[0][k]),'Invalid Blackjack Waveshare flash slice.');
    fail(release.partitions.length === BLACKJACK_WAVESHARE_PARTITIONS.length && release.partitions.every((r,i) => sameRow(r,BLACKJACK_WAVESHARE_PARTITIONS[i])),'Invalid Blackjack Waveshare factory map.');
    if (files) {
      const raw = files.get(app);
      fail(raw instanceof Uint8Array && raw.length === a.bytes,'Incomplete Blackjack Waveshare application.');
      fail(raw[0] === 0xe9 && raw[12] === 9 && raw[13] === 0 && raw[3] >> 4 === 5,'Blackjack Waveshare requires an ESP32-S3 32 MiB image.');
      fail(raw[32] === 0x32 && raw[33] === 0x54 && raw[34] === 0xcd && raw[35] === 0xab && new TextDecoder().decode(raw.subarray(48,80)).split('\0')[0] === release.version,'Blackjack embedded version differs.');
    }
    return;
  }
  fail(device.id === 'sticks3' && device.flashBytes === 0x800000 && release.contract === BLACKJACK_CONTRACT,'Unsupported Blackjack device contract.');
  fail(/^\d+\.\d+\.\d+$/.test(release.version),'Invalid Blackjack stable version.');
  const app = `blackjack-sticks3-${release.version}-app.bin`, install = `blackjack-sticks3-${release.version}-install.bin`;
  const a = release.files.find(f => f.id === app), b = release.files.find(f => f.id === install);
  fail(release.files.length === 2 && a && b && a.bytes > 256 && a.bytes <= 0x600000 && b.bytes === 0x10000+a.bytes,'Invalid Blackjack two-file contract.');
  const expected = blackjackParts(app,install,a.bytes);
  fail(Array.isArray(release.parts) && release.parts.length === expected.length && release.parts.every((p,i) => Object.keys(p).length === 5 && Object.keys(expected[i]).every(k => p[k] === expected[i][k])),'Invalid Blackjack flash slices.');
  fail(release.partitions.length === BLACKJACK_PARTITIONS.length && release.partitions.every((r,i) => sameRow(r,BLACKJACK_PARTITIONS[i])),'Invalid Blackjack partition map.');
  if (files) {
    const raw = files.get(app), merged = files.get(install);
    fail(raw instanceof Uint8Array && merged instanceof Uint8Array && raw.length === a.bytes && merged.length === b.bytes,'Incomplete Blackjack files.');
    fail(raw.every((v,i) => v === merged[0x10000+i]),'Blackjack app/install payloads differ.');
    fail(merged.subarray(0x9000,0xe000).every(v => v === 255),'Blackjack install contains NVS data.');
    fail(raw[32] === 0x32 && raw[33] === 0x54 && raw[34] === 0xcd && raw[35] === 0xab && new TextDecoder().decode(raw.subarray(48,80)).split('\0')[0] === release.version,'Blackjack embedded version differs.');
  }
}
export function blackjackInitializations(release, rows) {
  if (!isBlackjackStick(release)) return [];
  return BLACKJACK_PARTITIONS.slice(4).filter(r => !rows.some(old => sameRow(old,r)))
    .map(r => ({address:r.offset,length:r.size,kind:`initialize ${r.label}`,data:new Uint8Array(r.size).fill(255)}));
}
export function recoveryAuthority(release, device) {
  validateBlackjack(release,device);
  const ordinary = release.parts.map(p => ({address:p.address,length:Math.ceil(p.length/4096)*4096}));
  if (isBlackjackStick(release)) ordinary.push(...BLACKJACK_PARTITIONS.slice(4).map(p => ({address:p.offset,length:p.size})));
  return ordinary;
}
