import { ActivityPanel } from './activity.js';
import { renderPhoenixNotes } from './phoenix-notes.js';
import { loadSignedCatalog, RELEASE_KEY_FINGERPRINT } from './signing.js';
import { fetchReleaseStatus, describeReleaseStatus, pinRelease } from './release-status.js';
import { fetchFiles, inspectInstallation, prepare, encodeBackup, decodeBackup, installTransaction, restoreTransaction, requireThat } from './core.js';
import { DeviceConnection } from './serial.js';

const $ = id => document.getElementById(id);
const supportsUSB = isSecureContext && !!navigator.serial && !!crypto.subtle;
let catalog, releaseStatus, device, release, connection, identity, plan, recoveryPlan, inspection, downloadedFiles;
let busy = false, mutating = false, saved = false, resetOnClose = true;
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
const link = (text,url) => { const n = el('a',text); n.href = url; if(url.startsWith('#')) n.onclick=async()=>{ if(busy)return false; await disconnectAndClose(); const target=document.querySelector(url); if(target?.tagName==='DETAILS')target.open=true; target?.scrollIntoView(); }; return n; };
const activity = new ActivityPanel();
const status = (title,message,level='info') => { $('stage').textContent = title; $('status').textContent = message; activity.log.add(title+(message?' — '+message:''),level); };
const onEvent = event => {
  activity.event(event);
  if(event.type==='progress' && $('stage').textContent!==event.label){
    $('stage').textContent=event.label;
    $('status').textContent=event.phase==='download'?'Receiving the signed release files.':event.phase==='check'?'Checking the selected firmware and connected device.':'Keep this tab open and the USB cable connected.';
  }
};
function lock(value) {
  busy=value;$('close-dialog').disabled=value;$('model-confirm').disabled=value||!!connection;
  for(const id of ['connect','prepare','save','install','restore','finish','restore-open','offer-backup'])$(id).disabled=value;
  if(!value){
    $('connect').disabled=!supportsUSB||!$('model-confirm').checked;
    $('install').disabled=!connection||!identity||!!recoveryPlan||(inspection?.voxelFlightLayout&&!saved);
    $('restore').disabled=!connection||!recoveryPlan;
    $('prepare').disabled=!connection||!!recoveryPlan||!resetOnClose;
    $('save').disabled=!plan?.backupCaptured;
  }
  $('prepare').hidden=!!recoveryPlan;$('save').hidden=!plan?.backupCaptured;
}
function actions(...ids){for(const id of ['connect','install','restore','finish'])$(id).hidden=!ids.includes(id);}
function backupOffer(){
  const reason=inspection?.reason;const show=!!reason&&!saved&&!recoveryPlan;
  $('backup-offer').hidden=!show;if(!show)return;
  if(inspection.voxelFlightLayout){
    $('backup-offer-title').textContent=plan?.backupCaptured?'Recovery backup ready':'Voxel Flight layout detected';
    $('backup-offer-message').textContent='The installer replaces only the current app. The partition table and storage stay in place.';
    $('offer-backup').textContent=plan?.backupCaptured?'Save backup':'Create backup';
    $('backup-offer-hint').textContent='Save a recovery file before flashing.';
    return;
  }
  const titles={layout:'Storage layout will change',project:'A different project is installed',unknown:'Existing firmware is not recognized'};
  $('backup-offer-title').textContent=plan?.backupCaptured?'Recovery backup ready':titles[reason];
  $('backup-offer-message').textContent=plan?.backupCaptured?'Save the recovery file if you want to restore the previous firmware later.':reason==='layout'?'This installation replaces the current partition layout. A backup lets you put the overwritten sectors back.':reason==='project'?'This replaces a different application. A recovery backup lets you return to it.':'A recovery backup lets you put the overwritten sectors back if needed.';
  $('offer-backup').textContent=plan?.backupCaptured?'Save backup':'Back up first';
  $('backup-offer-hint').textContent='Optional — you can continue with Flash firmware.';
}
function errorMessage(error) {
  return error?.name === 'NotFoundError' ? 'Connection cancelled. No flash was written.' : String(error?.message || error);
}
function renderDevices() {
  $('devices').replaceChildren(...catalog.devices.map(d => {
    const b = el('button',undefined,'device'); b.type = 'button'; b.setAttribute('aria-pressed',String(device?.id === d.id)); b.setAttribute('aria-label',`Select ${d.name}`);
    const frame = el('span',undefined,'device-image'); const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('viewBox',d.viewBox); svg.setAttribute('role','img'); svg.setAttribute('aria-label',d.name); const clip=document.createElementNS('http://www.w3.org/2000/svg','clipPath'); clip.id='photo-'+d.id; const rect=document.createElementNS('http://www.w3.org/2000/svg','rect'); const box=d.viewBox.split(' '); ['x','y','width','height'].forEach((key,i)=>rect.setAttribute(key,box[i])); clip.append(rect); const defs=document.createElementNS('http://www.w3.org/2000/svg','defs'); defs.append(clip); svg.append(defs); const img=document.createElementNS('http://www.w3.org/2000/svg','image'); img.setAttribute('href',d.image); img.setAttribute('width','1774'); img.setAttribute('height','887'); img.setAttribute('clip-path','url(#photo-'+d.id+')'); svg.append(img); frame.append(svg);
    const text = el('span',undefined,'device-text'); text.append(el('strong',d.name),el('small',d.model)); b.append(frame,text,el('span','✓','device-mark'));
    b.onclick=()=>{ device=d; renderDevices(); renderProjects(); }; return b;
  }));
}
function renderProjects() {
  $('selection-label').textContent=device.name;
  $('projects').replaceChildren(...catalog.releases.filter(r=>r.device === device.id).map(r=>{
    const p=catalog.projects.find(p=>p.id===r.project); const card=el('article',undefined,'project');
    card.append(el('p',p.category.toUpperCase(),'category'),el('h3',p.name),el('p',r.description),el('p',r.version,'version'));
    const sync = describeReleaseStatus(releaseStatus,r);
    card.append(el('p',sync.message,'qualification'));
    if(sync.releaseUrl)card.append(link('GitHub release ↗',sync.releaseUrl));
    card.append(link('Source / build notes ↗',r.source));
    const bottom=el('div',undefined,'project-bottom'); const b=el('button','View & install →'); b.onclick=()=>openInstaller(r); bottom.append(el('span',r.status,'badge'+(r.status==='Preview'?' preview':'')),b); card.append(bottom); return card;
  }));
}
function openInstaller(r,restore) {
  r=pinRelease(r); release=r; recoveryPlan=restore||null; device=catalog.devices.find(d=>d.id===r.device); plan=null; saved=false; identity=null; inspection=null;downloadedFiles=null;resetOnClose=true;
  $('install-title').textContent=restore?'Restore previous firmware':catalog.projects.find(p=>p.id===r.project).name;
  $('install-subtitle').textContent=`${device.name} · ${restore?'Recovery backup':r.version}`;
  const info=$('release-info');
  info.replaceChildren(el('span',r.status,'badge'+(r.status==='Preview'?' preview':'')),el('p',restore?'Restore your saved sectors to the same device.':r.description));
  info.append(link('Project manual',r.manual),document.createTextNode(' · '),link('Source',r.source));
  const details=el('details');details.append(el('summary','Release details & firmware files'),el('p',restore?'This restores the saved flash sectors to the same physical device.':r.qualification));
  if(!restore){const sync=describeReleaseStatus(releaseStatus,r);details.append(el('p',sync.message));if(sync.releaseUrl)details.append(link('GitHub release',sync.releaseUrl));
    const list=el('ul');for(const f of r.files){const item=el('li');item.append(link(f.id,f.url),el('p',`${f.bytes.toLocaleString()} bytes`),el('code',f.sha256));list.append(item);}details.append(list);
  }
  info.append(details);
  $('recovery-guide').textContent=r.voxelFlightLayout?'Hold BOOT while powering or resetting, then release BOOT. The installer checks the existing partition layout before writing.':device.recovery;
  $('model-label').textContent=`My connected device is exactly the ${device.name}${device.id==='waveshare175c'?' (C model)':' / K150'}.`;
  $('model-confirm').checked=false;$('installer-advanced').open=false;$('backup-offer').hidden=true;
  $('replace-warning').textContent=restore?'Restoring replaces the current firmware with your saved sectors. Use only your own recovery file.':r.project === 'blackjack'?'Installing restarts the device. Compatible Blackjack updates preserve progress. Replacing another project can overwrite its storage.':'Installing replaces the current project and restarts the device. Save any current seed first.';
  activity.reset(r,!!restore);
  actions('connect'); status('Ready to connect','Choose the matching USB port when your browser asks.'); lock(false); $('installer').showModal();
}
$('model-confirm').onchange=()=>{ if(!busy)$('connect').disabled=!supportsUSB||!$('model-confirm').checked; };
$('connect').onclick=async()=>{
  if(busy||!$('model-confirm').checked||!supportsUSB)return;
  // Keep the chooser inside the user's gesture, before any asynchronous work.
  const portPromise=navigator.serial.requestPort();lock(true);activity.start('connect','Connecting to device');status('Connecting','Select the device USB port. This does not write flash.');
  try{
    const port=await portPromise;connection=new DeviceConnection(onEvent);identity=await connection.connect(port,device);
    // Recovery must also work with an interrupted/unparseable partition table.
    if(!recoveryPlan){
      inspection=await inspectInstallation(connection.loader,release,device,catalog,onEvent);
      if(device.id==='waveshare175c'&&inspection.reason==='layout'){
        status('Unsupported partition layout','This release cannot use the app slot on the connected Waveshare. No flash was written.','error');
        activity.fail();actions('finish');return;
      }
      backupOffer();
    }
    activity.finish(0,'Device connected');
    status('Device checked',`${identity.chip} · ${identity.capacity/1048576}MB flash. ${recoveryPlan?'Ready to restore your recovery file.':inspection.voxelFlightLayout?'Save a recovery file to enable Flash firmware.':'Choose Flash firmware. Backup is optional in Advanced.'}`);
    actions(recoveryPlan?'restore':'install','finish');
  }catch(e){try{await connection?.close();}catch{}connection=null;identity=null;status('Connection not completed',errorMessage(e),'error');activity.fail();actions('connect');}
  finally{lock(false);}
};
async function prepareInstallation(backup){
  if(plan&&(!backup||plan.backupCaptured))return plan;
  if(!downloadedFiles)downloadedFiles=await fetchFiles(release,fetch,status,onEvent);
  plan=await prepare(connection.loader,release,device,identity,downloadedFiles,()=>{},onEvent,{backup});
  requireThat(!inspection||plan.tableSha256===inspection.tableSha256,'Partition table changed since connection. Reconnect before flashing.');
  return plan;
}
$('prepare').onclick=async()=>{
  if(busy||!connection||!identity||recoveryPlan)return;
  lock(true);$('backup-offer').hidden=true;activity.start('backup','Creating optional recovery backup');$('installer-advanced').open=true;saved=false;
  try{
    await prepareInstallation(true);activity.finish(0,'Recovery data ready');
    if(!plan.ranges.length){status('This version is already installed','No changed sectors need a recovery backup.');actions('finish');}
    else{status('Recovery backup ready',inspection?.voxelFlightLayout?'Save the recovery file to enable Flash firmware.':'Save the recovery file below, or choose Flash firmware.');actions('install','finish');}
    backupOffer();
  }catch(e){plan=null;try{await connection?.close(true);}catch{}connection=null;identity=null;status('Backup stopped',errorMessage(e)+' No flash was written. Reconnect to continue.','error');activity.fail();actions('connect');}
  finally{lock(false);}
};
$('offer-backup').onclick=()=>{if(busy)return;$('installer-advanced').open=true;(plan?.backupCaptured?$('save'):$('prepare')).click();};
$('save').onclick=async()=>{
  if(busy||!plan?.backupCaptured||!plan.ranges.length)return;
  const name=`${device.id}-recovery.bflash`;
  const handlePromise=window.showSaveFilePicker?window.showSaveFilePicker({suggestedName:name,types:[{description:'Firmware recovery backup',accept:{'application/octet-stream':['.bflash']}}]}):null;
  lock(true);activity.start('save','Saving optional recovery backup');
  try{
    const handle=handlePromise?await handlePromise:null;const bytes=await encodeBackup(plan);
    if(handle){const writer=await handle.createWritable();await writer.write(bytes);await writer.close();saved=true;status('Backup saved','The recovery file was saved on your computer.');}
    else{
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));const a=link('',url);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
      if(inspection?.voxelFlightLayout) saved=window.confirm('Has the recovery file downloaded? Confirm only after saving it to your computer.');
      status(saved?'Backup saved':'Backup download requested',saved?'You can now flash the selected firmware.':'Keep the recovery file if you want to restore this firmware later.');
    }
    activity.finish(0,'Optional backup ready');backupOffer();
  }catch(e){activity.fail();status(e.name==='AbortError'?'Backup save cancelled':'Backup could not be saved',e.name==='AbortError'?'You can save it again or continue with Flash firmware.':errorMessage(e),'warning');}
  finally{lock(false);}
};
$('install').onclick=async()=>{
  if(busy||!connection||!identity||recoveryPlan||(inspection?.voxelFlightLayout&&!saved))return;
  lock(true);actions();$('backup-offer').hidden=true;activity.start('write','Checking firmware before flashing');
  try{
    await prepareInstallation(false);
    requireThat(!inspection?.voxelFlightLayout||plan.backupCaptured,'Save a recovery file before flashing.');
    if(!plan.ranges.length){activity.finish(2,'Firmware already matches');status('This version is already installed',`The selected firmware already matches ${release.version}. No flash was written.`);actions('finish');return;}
    mutating=true;
    const result=await installTransaction(connection.loader,plan,()=>connection.identify(),()=>{},onEvent);
    if(result.installed){activity.finish(2,'Flash written and verified');status('Installed & verified','All written ranges match. Restart the device, then check its display and buttons.','success');}
    else{activity.fail();status('Previous firmware restored','The install failed; the optional backup was restored and verified.','warning');}
    actions('finish');
  }catch(e){if(mutating)resetOnClose=false;status('Installation stopped',errorMessage(e),'error');activity.fail();actions('finish');}
  finally{mutating=false;lock(false);}
};
$('restore').onclick=async()=>{
  if(busy||!recoveryPlan||!connection)return;lock(true);mutating=true;actions();activity.start('restore','Checking recovery backup');
  try{await restoreTransaction(connection.loader,recoveryPlan,device,()=>connection.identify(),()=>{},onEvent);activity.finish(2,'Recovery written and verified');status('Recovery verified','The saved flash sectors match the connected device. Restart and check its display.','success');actions('finish');}
  catch(e){resetOnClose=false;status('Recovery not verified',errorMessage(e)+' Keep your recovery file and reconnect in flashing mode.','error');activity.fail();actions('finish');}
  finally{mutating=false;lock(false);}
};
async function disconnectAndClose(){if(busy)return;lock(true);try{await connection?.close(resetOnClose);}catch{status('USB disconnected','Reconnect or press reset to restart the device.');}finally{connection=null;identity=null;plan=null;recoveryPlan=null;lock(false);$('installer').close();}}
$('finish').onclick=disconnectAndClose;$('close-dialog').onclick=disconnectAndClose;
$('installer').addEventListener('cancel',e=>{e.preventDefault();if(!busy)disconnectAndClose();});
$('recovery-open').onclick=$('restore-open').onclick=()=>{if(!busy)$('backup-file').click();};
$('backup-file').onchange=async()=>{
  const file=$('backup-file').files[0];$('backup-file').value='';if(!file||busy)return;lock(true);
  try{
    requireThat(file.size<9*1024*1024,'Recovery file is too large.');const recovered=await decodeBackup(new Uint8Array(await file.arrayBuffer()),catalog);
    const archived=[...catalog.releases,...(catalog.recoveryReleases||[])];
    if(connection){await connection.close(false);connection=null;identity=null;}
    $('catalog-error').hidden=true;openInstaller(archived.find(r=>r.id===recovered.release&&r.device===recovered.device),recovered);
  }catch(e){$('catalog-error').hidden=false;$('catalog-error').textContent='Recovery file not accepted: '+errorMessage(e)+' No flash was written.';lock(false);}
};
window.addEventListener('beforeunload',e=>{if(mutating){e.preventDefault();e.returnValue='';}});
// A background refresh never changes an open installer's pinned release.
let refreshing=false;
async function refreshCatalog() {
  if(refreshing||busy||connection||$('installer').open||!catalog||document.hidden)return;
  refreshing=true;
  try {
    const [next,nextStatus]=await Promise.all([loadSignedCatalog(),fetchReleaseStatus()]);
    // The user may have opened an installer while the requests were in flight.
    if(busy||connection||$('installer').open)return;
    const selected=device?.id;
    catalog=next;releaseStatus=nextStatus;
    device=catalog.devices.find(d=>d.id===selected);
    $('catalog-error').hidden=true;renderPhoenixNotes(catalog);renderDevices();
    if(device)renderProjects();
  } catch(e) {
    if(busy||connection||$('installer').open)return;
    releaseStatus=null;
    $('catalog-error').hidden=false;
    $('catalog-error').textContent='Release refresh failed. Showing previously verified versions; latest release not confirmed. '+errorMessage(e);
    if(device)renderProjects();
  } finally {refreshing=false;}
}
setInterval(refreshCatalog,5*60000);
// Recompute the age label even if a sync service has stopped producing updates.
setInterval(()=>{if(device&&!busy&&!connection&&!$('installer').open)renderProjects();},60000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshCatalog();});
try{[catalog,releaseStatus]=await Promise.all([loadSignedCatalog(),fetchReleaseStatus()]); $('signature-status').textContent='Release catalog signature verified · Ed25519'; $('signature-fingerprint').textContent=RELEASE_KEY_FINGERPRINT; renderPhoenixNotes(catalog); renderDevices();
  $('other-projects').replaceChildren(...catalog.otherProjects.map(p=>{const a=link('',p.url);a.append(el('strong',p.name),el('span','↗'),el('small',p.detail));return a;}));
  $('unsupported').hidden=supportsUSB;
  const project=new URL(location.href).searchParams.get('project');
  const initial=catalog.releases.find(r=>r.project===project);
  if(initial){device=catalog.devices.find(d=>d.id===initial.device);renderDevices();renderProjects();openInstaller(initial);}
}catch(e){$('signature-status').textContent='Release signature not verified — installation unavailable';$('catalog-error').hidden=false;$('catalog-error').textContent=errorMessage(e);}
