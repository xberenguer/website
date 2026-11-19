// Optional actual-Chrome UI smoke. Synthetic catalog, ephemeral test signer,
// cancelled fake port chooser: no network, USB access, firmware or production key.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {chromium}=require('playwright');
(async()=>{
 const root=path.resolve(__dirname,'../..');
 const {BLACKJACK_PARTITIONS,blackjackParts,BLACKJACK_WAVESHARE_PARTITIONS,BLACKJACK_WAVESHARE_CONTRACT,blackjackWaveshareParts}=await import('../blackjack.js');
 const catalog=JSON.parse(await fs.readFile(path.join(root,'flasher/catalog.json')));
 // Replace any real/archived Blackjack offering with this synthetic UI fixture.
 catalog.projects=catalog.projects.filter(p=>p.id!=='blackjack');
 catalog.releases=catalog.releases.filter(r=>r.project!=='blackjack');
 catalog.recoveryReleases=(catalog.recoveryReleases||[]).filter(r=>r.project!=='blackjack');
 const version='99.0.0',app=`blackjack-sticks3-${version}-app.bin`,install=`blackjack-sticks3-${version}-install.bin`;
 const release={id:`blackjack-sticks3-${version}`,project:'blackjack',device:'sticks3',version,contract:'blackjack-sticks3-v1',status:'Preview',description:'Synthetic offline UI fixture',qualification:'Synthetic fixture only. Browser StickS3 installation/migration requires physical qualification.',source:'https://github.com/xberenguer/blackjack-trainer',manual:'https://github.com/xberenguer/blackjack-trainer/blob/main/docs/INSTALL.md',files:[app,install].map((id,i)=>({id,url:'firmware/'+id,bytes:512+(i?65536:0),sha256:'0'.repeat(64)})),parts:blackjackParts(app,install,512),partitions:BLACKJACK_PARTITIONS};
 catalog.projects.push({id:'blackjack',name:'Blackjack Trainer',category:'Training',url:'https://github.com/xberenguer/blackjack-trainer'});catalog.releases.push(release);
 const waveApp=`blackjack-waveshare175c-${version}-app.bin`;
 const waveRelease={...release,id:`blackjack-waveshare175c-${version}`,device:'waveshare175c',contract:BLACKJACK_WAVESHARE_CONTRACT,qualification:'Synthetic fixture only. Browser Waveshare application-only installation requires physical qualification. Factory data and private journals excluded.',files:[{id:waveApp,url:'firmware/'+waveApp,bytes:512,sha256:'0'.repeat(64)}],parts:blackjackWaveshareParts(waveApp,512),partitions:BLACKJACK_WAVESHARE_PARTITIONS};
 catalog.releases.push(waveRelease);
 const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');
 const rawPublic=publicKey.export({format:'der',type:'spki'}).subarray(-32),fingerprint=crypto.createHash('sha256').update(rawPublic).digest('hex');
 const raw=Buffer.from(JSON.stringify(catalog));const envelope=JSON.stringify({format:1,catalog:raw.toString('base64'),signature:crypto.sign(null,raw,privateKey).toString('base64')});
 const signer=(await fs.readFile(path.join(root,'flasher/signing.js'),'utf8')).replace('044b1a970af958277f4a742b0f4544526406ac99e00575d25f5bbf0b17b28a7a',rawPublic.toString('hex')).replace('34568ae48435426bb68028eb6f3bb338a2cba5115c906a33ca26c3592c31c5d4',fingerprint);
 const types={'.html':'text/html','.js':'text/javascript','.json':'application/json','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'};
 const server=http.createServer(async(req,res)=>{try{let url=new URL(req.url,'http://localhost');let name=decodeURIComponent(url.pathname);if(name.endsWith('/'))name+='index.html';let data;
  if(name==='/flasher/catalog.signed.json')data=envelope;
  else if(name==='/flasher/signing.js')data=signer;
  else if(name==='/flasher/release-status.json')data=JSON.stringify({checkedAt:new Date().toISOString(),projects:[{project:'blackjack',repository:'xberenguer/blackjack-trainer',state:'current',tag:'v'+version,message:'Synthetic fixture',devices:[{device:'sticks3',offeredVersion:version},{device:'waveshare175c',offeredVersion:version}]}]});
  else {const file=path.resolve(root,'.'+name);if(!file.startsWith(root+path.sep))throw Error('path');data=await fs.readFile(file);}
  res.writeHead(200,{'Content-Type':types[path.extname(name)]||'application/octet-stream'});res.end(data);
 }catch{res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript(()=>{window.__portRequests=0;Object.defineProperty(navigator,'serial',{value:{requestPort:()=>{window.__portRequests++;return Promise.reject(new DOMException('Synthetic cancellation','NotFoundError'));}}});});
  const origin=`http://127.0.0.1:${server.address().port}`;
  await page.goto(origin+'/flasher/?project=blackjack');
  await page.locator('#installer').waitFor({state:'visible'});
  assert.equal(await page.locator('#install-title').textContent(),'Blackjack Trainer');
  assert.match(await page.locator('#release-info').textContent(),/Preview.*physical qualification/s);
  assert.equal(await page.locator('#connect').isDisabled(),true);
  assert.equal(await page.locator('#install').isDisabled(),true);
  await page.locator('#model-confirm').check();assert.equal(await page.locator('#connect').isEnabled(),true);
  await page.locator('#connect').click();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('Connection cancelled'));
  assert.equal(await page.evaluate(()=>window.__portRequests),1);assert.equal(await page.locator('#install').isDisabled(),true);
  if(process.env.BROWSER_TEST_OUTPUT){await fs.mkdir(process.env.BROWSER_TEST_OUTPUT,{recursive:true});await page.screenshot({path:path.join(process.env.BROWSER_TEST_OUTPUT,'blackjack-installer.png'),fullPage:true});}
  await page.locator('#close-dialog').click();
  await page.getByRole('button',{name:'Select Waveshare AMOLED 1.75C'}).click();
  assert.equal(await page.locator('#projects').getByText('Blackjack Trainer',{exact:true}).count(),1);
  await page.locator('#projects article').filter({hasText:'Blackjack Trainer'}).getByRole('button',{name:'Install'}).click();
  assert.match(await page.locator('#install-subtitle').textContent(),/Waveshare.*99.0.0/);
  assert.match(await page.locator('#release-info').textContent(),/blackjack-waveshare175c-99.0.0-app.bin/);
  assert.equal(await page.locator('#connect').isDisabled(),true);assert.equal(await page.locator('#install').isDisabled(),true);
  await page.locator('#model-confirm').check();await page.locator('#connect').click();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('Connection cancelled'));
  assert.equal(await page.evaluate(()=>window.__portRequests),2);
  if(process.env.BROWSER_TEST_OUTPUT)await page.screenshot({path:path.join(process.env.BROWSER_TEST_OUTPUT,'blackjack-round-installer.png'),fullPage:true});
  await page.locator('#close-dialog').click();
  await page.getByRole('button',{name:/Select M5Stack StickS3/}).click();
  assert.equal(await page.locator('#projects').getByText('Blackjack Trainer',{exact:true}).count(),1);
  assert.deepEqual(errors,[]);
  console.log('PASS actual Chrome: ephemeral signed synthetic Blackjack card, deep link, Preview/manual/files, board filtering, model/backup gates, cancelled fake USB chooser. No device accessed.');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1;});
