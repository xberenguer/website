// Isolated Chrome acceptance: real signed catalog/core/UI, simulated USB only.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const {chromium}=require(process.env.FLASHER_PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const root=path.resolve(__dirname,'../..');const catalog=JSON.parse(await fs.readFile(path.join(root,'flasher/catalog.json')));
 const serial=`import {md5Hex} from './core.js';
 const catalog=${JSON.stringify(catalog)};
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const unhex=s=>Uint8Array.from(s.match(/../g).map(x=>parseInt(x,16)));
 function table(rows){const b=new Uint8Array(4096).fill(255),v=new DataView(b.buffer);rows.forEach((r,i)=>{const o=i*32;v.setUint16(o,0x50aa,true);b[o+2]=r.type;b[o+3]=r.subtype;v.setUint32(o+4,r.offset,true);v.setUint32(o+8,r.size,true);b.fill(0,o+12,o+28);b.set(new TextEncoder().encode(r.label),o+12);v.setUint32(o+28,r.flags,true);});const o=rows.length*32;v.setUint16(o,0xebeb,true);b.set(unhex(md5Hex(b.subarray(0,o))),o+16);return b;}
 class Loader{
 constructor(device,release){this.memory=new Uint8Array(device.flashBytes).fill(77);this.memory.set(table(release.partitions),0x8000);this.IS_STUB=true;this.ESP_READ_FLASH=0xd2;this.packets=[];this.transport={read:async()=>this.packets.shift(),write:async()=>{}};}
 async checkCommand(_,op,r){const v=new DataView(r.buffer,r.byteOffset),at=v.getUint32(0,true),n=v.getUint32(4,true),size=v.getUint32(8,true),b=this.memory.slice(at,at+n);this.packets=[];for(let i=0;i<n;i+=size)this.packets.push(b.slice(i,i+size));this.packets.push(unhex(md5Hex(b)));return 0;}
 async flashMd5sum(at,n){if(this.wrote&&window.__pauseAfterWrite){window.__awaitingVerification=true;await new Promise(r=>window.__continueVerification=()=>{window.__pauseAfterWrite=false;r();});}return md5Hex(this.memory.subarray(at,at+n));}
 async writeFlash(options){for(let i=0;i<options.fileArray.length;i++){const f=options.fileArray[i];options.reportProgress(i,0,f.data.length);await wait(70);options.reportProgress(i,Math.floor(f.data.length/2),f.data.length);
 if(window.__failInstall&&!this.failed){this.failed=true;this.memory.set(f.data.subarray(0,Math.floor(f.data.length/2)),f.address);throw Error('Synthetic interrupted write');}
 if(window.__pauseMidWrite){window.__writingPaused=true;await new Promise(r=>window.__continueWrite=()=>{window.__pauseMidWrite=false;r();});}
 await wait(70);this.memory.set(f.data,f.address);options.reportProgress(i,f.data.length,f.data.length);}this.wrote=true;}
 }
 export class DeviceConnection{constructor(onEvent){this.onEvent=onEvent;}async connect(port,device){this.device=device;const project=new URL(location.href).searchParams.get('project');const release=catalog.releases.find(r=>r.project===project&&r.device===device.id);this.loader=new Loader(device,release);this.onEvent({type:'terminal',text:'Synthetic USB fixture — no physical device',newline:true});this.onEvent({type:'terminal',text:'Chip: ESP32-S3',newline:true});return this.identify();}async identify(){return {chip:'ESP32-S3',imageChipId:9,capacity:this.device.flashBytes,mac:'12:34:56:78:9a:bc'};}async close(){}}
 `;
 const types={'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.bin':'application/octet-stream'};
 const server=http.createServer(async(req,res)=>{try{let name=new URL(req.url,'http://localhost').pathname;if(name.endsWith('/'))name+='index.html';const file=path.resolve(root,'.'+decodeURIComponent(name));assert(file.startsWith(root+path.sep));let data=name==='/flasher/serial.js'?serial:await fs.readFile(file);
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
   window.__pauseMidWrite=true;window.__pauseAfterWrite=true;
  });
  const origin=`http://127.0.0.1:${server.address().port}`;
  for(const r of catalog.releases){
   await page.goto(origin+'/flasher/?project='+r.project);await page.locator('#installer').waitFor({state:'visible'});
   const d=catalog.devices.find(d=>d.id===r.device);
   if(!(await page.locator('#install-subtitle').textContent()).includes(d.name)){
    await page.locator('#close-dialog').click();await page.getByRole('button',{name:'Select '+d.name,exact:true}).click();
    const project=catalog.projects.find(p=>p.id===r.project);await page.locator('#projects .project').filter({has:page.getByRole('heading',{name:project.name,exact:true})}).getByRole('button',{name:'View & install →',exact:true}).click();
   }
   assert.match(await page.locator('#activity-log').textContent(),new RegExp(r.project));assert.equal(await page.locator('#progress-value').textContent(),'Ready');
   await page.locator('#model-confirm').check();await page.locator('#connect').click();await page.waitForFunction(()=>document.getElementById('stage').textContent==='Device checked');
   await page.waitForFunction(()=>document.getElementById('activity-log').textContent.includes('Chip: ESP32-S3'));
   assert.match(await page.locator('#activity-log').textContent(),/ESPTOOL.*Chip: ESP32-S3/);assert.equal(await page.locator('#install').isDisabled(),true);
   if(r.project!=='blackjack'){await page.locator('#finish').click();continue;}
   await page.locator('#prepare').click();await page.waitForFunction(()=>document.getElementById('stage').textContent==='Recovery backup prepared',{},{timeout:90000});
   await page.waitForFunction(()=>document.getElementById('activity-log').textContent.includes('Backup MD5 OK'));
   const log=await page.locator('#activity-log').textContent();assert.match(log,/SHA-256 OK/);assert.match(log,/Backup MD5 OK/);assert.doesNotMatch(log,/12:34:56:78:9a:bc/);
   assert.equal(await page.locator('#install').isDisabled(),true);await page.locator('#save').click();await page.waitForFunction(()=>document.getElementById('stage').textContent==='Backup saved');assert(await page.evaluate(()=>window.__savedBackupBytes>3000000));
   await page.locator('#install').click();await page.waitForFunction(()=>window.__writingPaused);
   assert.equal(await page.locator('#progress-value').textContent(),'50%');assert.notEqual(await page.locator('#stage').textContent(),'Installed & verified');
   if(out)await page.screenshot({path:path.join(out,'flasher-activity-simulated-desktop.png')});
   const download=await Promise.all([page.waitForEvent('download'),page.locator('#download-log').click()]);assert.match(download[0].suggestedFilename(),/activity\.txt$/);
   await page.evaluate(()=>window.__continueWrite());await page.waitForFunction(()=>window.__awaitingVerification);
   assert.equal(await page.locator('#stage').textContent(),'Verifying written flash');assert.equal(await page.locator('#progress-value').textContent(),'0%');
   await page.evaluate(()=>window.__continueVerification());await page.waitForFunction(()=>document.getElementById('stage').textContent==='Installed & verified');await page.waitForFunction(()=>document.getElementById('activity-log').textContent.includes('Flash MD5 OK'));assert.match(await page.locator('#activity-log').textContent(),/Flash MD5 OK/);
   await page.setViewportSize({width:390,height:844});await page.locator('#activity-log').scrollIntoViewIfNeeded();
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.equal(await page.locator('#activity-log').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true);
   if(out)await page.screenshot({path:path.join(out,'flasher-activity-simulated-mobile.png')});
   await page.setViewportSize({width:1280,height:940});await page.locator('#finish').click();
  }
  // A failed write must retain its error and show verified rollback, never success.
  await page.goto(origin+'/flasher/?project=blackjack');await page.locator('#installer').waitFor({state:'visible'});
  await page.evaluate(()=>{window.__pauseMidWrite=false;window.__pauseAfterWrite=false;window.__failInstall=true;});
  await page.locator('#model-confirm').check();await page.locator('#connect').click();await page.locator('#prepare').click();await page.waitForFunction(()=>document.getElementById('stage').textContent==='Recovery backup prepared',{},{timeout:90000});await page.locator('#save').click();await page.waitForFunction(()=>document.getElementById('stage').textContent==='Backup saved');await page.locator('#install').click();await page.waitForFunction(()=>document.getElementById('stage').textContent==='Previous firmware restored',{},{timeout:90000});
  await page.waitForFunction(()=>document.getElementById('activity-log').textContent.includes('Verifying automatic recovery'));
  assert.match(await page.locator('#activity-log').textContent(),/Synthetic interrupted write.*Attempting automatic recovery/s);assert.match(await page.locator('#activity-log').textContent(),/Verifying automatic recovery/);assert.equal(await page.locator('#status-box').getAttribute('data-state'),'error');assert.deepEqual(errors,[]);
  console.log(`PASS actual Chrome: all ${catalog.releases.length} device/project offerings show console; signed streamed downloads, backup/save gate, actual callback50%, separate final verification, log download, mobile layout and verified rollback. Simulated USB only.`);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
