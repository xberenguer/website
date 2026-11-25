// Isolated Chrome acceptance: real signed catalog/core/UI, simulated USB only.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {generateKeyPairSync,sign}=require('node:crypto');
const {chromium}=require(process.env.FLASHER_PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const root=path.resolve(__dirname,'../..');const catalog=JSON.parse(await fs.readFile(path.join(root,'flasher/catalog.json')));
 const waveSeeder=catalog.releases.find(r=>r.project==='seeder'&&r.device==='waveshare175c');
 waveSeeder.voxelFlightLayout=true;
 // Sign the explicitly opted-in fixture with a disposable key limited to this server.
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const fixtureKey=publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex');
 const payload=Buffer.from(JSON.stringify(catalog));
 const envelope=JSON.stringify({format:1,catalog:payload.toString('base64'),signature:sign(null,payload,privateKey).toString('base64')});
 const serial=`import {md5Hex} from './core.js';
 const catalog=${JSON.stringify(catalog)};
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const unhex=s=>Uint8Array.from(s.match(/../g).map(x=>parseInt(x,16)));
 function table(rows){const b=new Uint8Array(4096).fill(255),v=new DataView(b.buffer);rows.forEach((r,i)=>{const o=i*32;v.setUint16(o,0x50aa,true);b[o+2]=r.type;b[o+3]=r.subtype;v.setUint32(o+4,r.offset,true);v.setUint32(o+8,r.size,true);b.fill(0,o+12,o+28);b.set(new TextEncoder().encode(r.label),o+12);v.setUint32(o+28,r.flags,true);});const o=rows.length*32;v.setUint16(o,0xebeb,true);b.set(unhex(md5Hex(b.subarray(0,o))),o+16);return b;}
 class Loader{
 constructor(device,release){this.memory=new Uint8Array(device.flashBytes).fill(77);const voxel={parts:[{kind:'application',address:0x10000}],project:'voxel-flight',partitions:[[1,2,0x9000,0x6000,'nvs'],[1,1,0xf000,0x1000,'phy_init'],[0,0,0x10000,0x500000,'factory'],[1,129,0x510000,0x1af0000,'storage']].map(([type,subtype,offset,size,label])=>({type,subtype,offset,size,label,flags:0}))};const prior=window.__voxelFlightLayout?voxel:window.__foreignLayout?catalog.releases.find(r=>r.project==='seeder'&&r.device===device.id):release;this.memory.set(table(prior.partitions),0x8000);const a=prior.parts.find(p=>p.kind==='application').address;this.memory[a]=0xe9;this.memory.set(unhex('3254cdab'),a+32);this.memory.fill(0,a+80,a+112);const names={seeder:'arduino-lib-builder',phoenix:'arduino-lib-builder',blackjack:'stardust-sticks3',stopwatch:'stopwatch-firmware'};this.memory.set(new TextEncoder().encode(window.__unknownApp?'custom-app':names[window.__currentProject||prior.project]),a+80);if(window.__damagedTable)this.memory.fill(0,0x8000,0x9000);this.IS_STUB=true;this.ESP_READ_FLASH=0xd2;this.packets=[];this.transport={read:async()=>this.packets.shift(),write:async()=>{}};}
 async checkCommand(_,op,r){const v=new DataView(r.buffer,r.byteOffset),at=v.getUint32(0,true),n=v.getUint32(4,true),size=v.getUint32(8,true),b=this.memory.slice(at,at+n);window.__readBytes=(window.__readBytes||0)+n;this.packets=[];for(let i=0;i<n;i+=size)this.packets.push(b.slice(i,i+size));this.packets.push(unhex(md5Hex(b)));return 0;}
 async flashMd5sum(at,n){if(this.wrote&&window.__pauseAfterWrite){window.__awaitingVerification=true;await new Promise(r=>window.__continueVerification=()=>{window.__pauseAfterWrite=false;r();});}return md5Hex(this.memory.subarray(at,at+n));}
 async writeFlash(options){window.__writeCalls=(window.__writeCalls||0)+1;window.__writeAddresses=options.fileArray.map(f=>f.address);for(let i=0;i<options.fileArray.length;i++){const f=options.fileArray[i];options.reportProgress(i,0,f.data.length);await wait(70);options.reportProgress(i,Math.floor(f.data.length/2),f.data.length);
 if(window.__failInstall&&!this.failed){this.failed=true;this.memory.set(f.data.subarray(0,Math.floor(f.data.length/2)),f.address);throw Error('Synthetic interrupted write');}
 if(window.__pauseMidWrite){window.__writingPaused=true;await new Promise(r=>window.__continueWrite=()=>{window.__pauseMidWrite=false;r();});}
 await wait(70);this.memory.set(f.data,f.address);options.reportProgress(i,f.data.length,f.data.length);}this.wrote=true;}
 }
 export class DeviceConnection{constructor(onEvent){this.onEvent=onEvent;}async connect(port,device){this.device=device;const project=new URL(location.href).searchParams.get('project');const release=catalog.releases.find(r=>r.project===project&&r.device===device.id);this.loader=new Loader(device,release);this.onEvent({type:'terminal',text:'Synthetic USB fixture — no physical device',newline:true});this.onEvent({type:'terminal',text:'Chip: ESP32-S3',newline:true});return this.identify();}async identify(){return {chip:'ESP32-S3',imageChipId:9,capacity:this.device.flashBytes,mac:'12:34:56:78:9a:bc'};}async close(){}}
 `;
 const types={'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.bin':'application/octet-stream'};
 const server=http.createServer(async(req,res)=>{try{let name=new URL(req.url,'http://localhost').pathname;if(name.endsWith('/'))name+='index.html';const file=path.resolve(root,'.'+decodeURIComponent(name));assert(file.startsWith(root+path.sep));let data=name==='/flasher/serial.js'?serial:await fs.readFile(file);
 if(name==='/flasher/catalog.signed.json')data=envelope;
 if(name==='/flasher/signing.js')data=data.toString().replace(/(const TRUSTED_RELEASE_KEY = ')[0-9a-f]{64}/, (_,prefix)=>prefix+fixtureKey);
 if(name==='/flasher/index.html')data=data.toString().replace('<span class="eyebrow">USB INSTALLER</span>','<span class="eyebrow">SIMULATED USB TEST · NO DEVICE CONNECTED</span>');
 res.writeHead(200,{'Content-Type':types[path.extname(name)]||'application/octet-stream'});res.end(data);}catch(e){res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
 const out=process.env.BROWSER_TEST_OUTPUT;if(out)await fs.mkdir(out,{recursive:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:940}});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>{
   Object.defineProperty(navigator,'serial',{value:{requestPort:async()=>({})}});
   window.showSaveFilePicker=async()=>({createWritable:async()=>({write:async bytes=>{window.__savedBackupBytes=bytes.length;},close:async()=>{}})});
   window.__pauseMidWrite=false;window.__pauseAfterWrite=false;
  });
  const origin=`http://127.0.0.1:${server.address().port}`;
  async function choose(r){
   await page.goto(origin+'/flasher/?project='+r.project);await page.locator('#installer').waitFor({state:'visible'});
   const d=catalog.devices.find(d=>d.id===r.device);
   if(!(await page.locator('#install-subtitle').textContent()).includes(d.name)){
    await page.locator('#close-dialog').click();await page.getByRole('button',{name:'Select '+d.name,exact:true}).click();
    const project=catalog.projects.find(p=>p.id===r.project);await page.locator('#projects .project').filter({has:page.getByRole('heading',{name:project.name,exact:true})}).getByRole('button',{name:'View & install →',exact:true}).click();
   }
   assert.deepEqual((await page.locator('#install-steps li').allTextContents()).map(s=>s.trim().replace(/\s+/g,' ')),['1 Connect','2 Flash','3 Verify']);
   assert.equal(await page.locator('#installer-advanced').getAttribute('open'),null);
  }
  async function connect(){await page.locator('#model-confirm').check();await page.locator('#connect').click();await page.waitForFunction(()=>document.getElementById('stage').textContent==='Device checked');}
  async function settled(title){await page.waitForFunction(t=>document.getElementById('stage').textContent===t,title,{timeout:90000});}
  const blackjack=catalog.releases.find(r=>r.project==='blackjack');
  for(const r of catalog.releases){
   await choose(r);if(r.project==='blackjack')await page.evaluate(()=>{window.__pauseMidWrite=true;window.__pauseAfterWrite=true;});
   await connect();assert.equal(await page.locator('#install').isEnabled(),true);assert.equal(await page.locator('#backup-offer').isHidden(),true);
   await page.locator('#install').click();
   if(r.project==='blackjack'){
    await page.waitForFunction(()=>window.__writingPaused);assert.equal(await page.locator('#progress-value').textContent(),'50%');
    if(out)await page.screenshot({path:path.join(out,'flasher-optional-simulated-desktop.png')});
    const download=await Promise.all([page.waitForEvent('download'),page.locator('#download-log').click()]);assert.match(download[0].suggestedFilename(),/activity\.txt$/);
    await page.evaluate(()=>window.__continueWrite());await page.waitForFunction(()=>window.__awaitingVerification);
    assert.equal(await page.locator('#stage').textContent(),'Verifying written flash');assert.equal(await page.locator('#progress-value').textContent(),'0%');await page.evaluate(()=>window.__continueVerification());
   }
   await settled('Installed & verified');await page.waitForFunction(()=>document.getElementById('activity-log').textContent.includes('Recovery backup skipped'));
   assert.equal(await page.evaluate(()=>window.__savedBackupBytes),undefined);assert.ok(await page.evaluate(()=>window.__readBytes<65536));
   assert.equal(await page.locator('#installer-advanced').getAttribute('open'),null);
   if(r.project==='blackjack'){
    await page.setViewportSize({width:390,height:844});await page.locator('#activity-log').scrollIntoViewIfNeeded();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(out)await page.screenshot({path:path.join(out,'flasher-optional-simulated-mobile.png')});await page.setViewportSize({width:1280,height:940});
   }
   await page.locator('#finish').click();
  }
  // Optional Advanced capture remains useful: local file, verified rollback and restore.
  await choose(blackjack);await connect();await page.locator('#installer-advanced > summary').click();
  await page.locator('#prepare').click();await settled('Recovery backup ready');assert.equal(await page.locator('#install').isEnabled(),true);
  await page.locator('#save').click();await settled('Backup saved');assert(await page.evaluate(()=>window.__savedBackupBytes>3000000));
  await page.evaluate(()=>{window.showSaveFilePicker=undefined;});
  const backupDownload=await Promise.all([page.waitForEvent('download'),page.locator('#save').click()]);const backupPath=await backupDownload[0].path();assert.match(backupDownload[0].suggestedFilename(),/recovery\.bflash$/);
  await page.evaluate(()=>{window.__failInstall=true;});await page.locator('#install').click();await settled('Previous firmware restored');assert.equal(await page.evaluate(()=>window.__writeCalls),2);
  await page.evaluate(()=>{window.__failInstall=false;window.__damagedTable=true;});await page.locator('#backup-file').setInputFiles(backupPath);await page.waitForFunction(()=>document.getElementById('install-title').textContent==='Restore previous firmware');
  await connect();assert.equal(await page.locator('#restore').isEnabled(),true);await page.locator('#restore').click();await settled('Recovery verified');await page.locator('#finish').click();
  // Failed default writes do not invent rollback when none was captured.
  await choose(blackjack);await connect();await page.evaluate(()=>{window.__failInstall=true;});await page.locator('#install').click();await settled('Installation stopped');
  assert.match(await page.locator('#status').textContent(),/without a recovery backup/);assert.equal(await page.evaluate(()=>window.__writeCalls),1);assert.equal(await page.locator('#prepare').isDisabled(),true);await page.locator('#finish').click();
  // A replacement offer is prominent and optional; default migration still works.
  await choose(blackjack);await page.evaluate(()=>{window.__foreignLayout=true;});await connect();assert.equal(await page.locator('#backup-offer').isVisible(),true);assert.equal(await page.locator('#backup-offer-title').textContent(),'Storage layout will change');assert.equal(await page.locator('#install').isEnabled(),true);
  if(out)await page.screenshot({path:path.join(out,'flasher-optional-replacement-offer.png')});await page.locator('#install').click();await settled('Installed & verified');assert.equal(await page.evaluate(()=>window.__savedBackupBytes),undefined);await page.locator('#finish').click();
  const stopwatch=catalog.releases.find(r=>r.project==='stopwatch');await choose(stopwatch);await page.evaluate(()=>{window.__currentProject='seeder';});await connect();assert.equal(await page.locator('#backup-offer-title').textContent(),'A different project is installed');await page.locator('#finish').click();
  await choose(blackjack);await page.evaluate(()=>{window.__unknownApp=true;});await connect();assert.equal(await page.locator('#backup-offer-title').textContent(),'Existing firmware is not recognized');assert.deepEqual(errors,[]);
  await page.locator('#finish').click();
  await choose(waveSeeder);await page.evaluate(()=>{window.__voxelFlightLayout=true;});await connect();
  assert.equal(await page.locator('#backup-offer-title').textContent(),'Voxel Flight layout detected');
  assert.equal(await page.locator('#install').isDisabled(),true);
  await page.locator('#offer-backup').click();await settled('Recovery backup ready');
  assert.equal(await page.locator('#install').isDisabled(),true);
  await page.locator('#offer-backup').click();await settled('Backup saved');
  assert.equal(await page.locator('#install').isEnabled(),true);
  await page.locator('#install').click();await settled('Installed & verified');
  assert.deepEqual(await page.evaluate(()=>window.__writeAddresses),[0x10000]);
  await page.locator('#finish').click();

  await choose(stopwatch);await page.evaluate(()=>{window.__voxelFlightLayout=true;});
  await page.locator('#model-confirm').check();await page.locator('#connect').click();await settled('Unsupported partition layout');
  assert.equal(await page.locator('#install').isHidden(),true);
  assert.equal(await page.locator('#progress-value').textContent(),'Stopped');
  assert.equal(await page.locator('#progress').isHidden(),true);
  assert.equal(await page.evaluate(()=>window.__writeCalls),undefined);
  assert.doesNotMatch(await page.locator('#activity-log').textContent(),/Downloading firmware/);
  assert.deepEqual(errors,[]);
  console.log(`PASS actual Chrome: all ${catalog.releases.length} offerings Connect→Flash→Verify without backup/save; <64KiB reads; optional Advanced capture/save/rollback/restore of damaged table; honest fast-path failure; replacement/unknown offers; real callback50%, separate verification, log export and mobile; approved Voxel Flight backup gate and alternate write address. Simulated USB only.`);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
