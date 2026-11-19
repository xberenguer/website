import { ActivityPanel } from './activity.js';
import { renderPhoenixNotes } from './phoenix-notes.js';
import { loadSignedCatalog, RELEASE_KEY_FINGERPRINT } from './signing.js';
import { fetchReleaseStatus, describeReleaseStatus, pinRelease } from './release-status.js';
import { fetchFiles, prepare, encodeBackup, decodeBackup, installTransaction, restoreTransaction, requireThat } from './core.js';
import { DeviceConnection } from './serial.js';

const $ = id => document.getElementById(id);
const supportsUSB = isSecureContext && !!navigator.serial && !!crypto.subtle;
let catalog, releaseStatus, device, release, connection, identity, plan, recoveryPlan;
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
  busy = value; $('close-dialog').disabled = value; $('model-confirm').disabled = value || !!connection;
  for (const id of ['connect','prepare','save','install','restore','finish']) $(id).disabled = value;
  if (!value) { $('connect').disabled = !supportsUSB || !$('model-confirm').checked; $('install').disabled = !saved; }
}
function actions(...ids) { for (const id of ['connect','prepare','save','install','restore','finish']) $(id).hidden = !ids.includes(id); }
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
  r=pinRelease(r); release=r; recoveryPlan=restore||null; device=catalog.devices.find(d=>d.id===r.device); plan=null; saved=false; identity=null; resetOnClose=true;
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
  $('recovery-guide').textContent=device.recovery;
  $('model-label').textContent=`My connected device is exactly the ${device.name}${device.id==='waveshare175c'?' (C model)':' / K150'}.`;
  $('model-confirm').checked=false; $('backup-confirm').checked=false; $('saved-check').hidden=true;
  $('replace-warning').textContent=restore?'Restoring replaces the current firmware with your saved sectors. Use only your own recovery file.':r.project === 'blackjack'?'Installing restarts the device. Compatible Blackjack journals are preserved; replacing another project can overwrite its storage. Save the recovery backup before writing.':'Installing replaces the current project and restarts the device. Save any current seed first.';
  activity.reset(r,!!restore);
  actions('connect'); status('Ready to connect','Choose the matching USB port when your browser asks.'); lock(false); $('installer').showModal();
}
$('model-confirm').onchange=()=>{ if(!busy)$('connect').disabled=!supportsUSB||!$('model-confirm').checked; };
$('connect').onclick=async()=>{
  if(busy||!$('model-confirm').checked||!supportsUSB)return;
  // requestPort stays directly within the click gesture; no asynchronous fetch comes first.
  const portPromise=navigator.serial.requestPort(); lock(true); activity.start('connect','Connecting to device'); status('Connecting','Select the device USB port. This does not write flash.');
  try { const port=await portPromise; connection=new DeviceConnection(onEvent); identity=await connection.connect(port,device);
    status('Device checked',`${identity.chip} · ${identity.capacity/1048576}MB flash. ${recoveryPlan?'Ready to verify and restore the saved sectors.':'Ready to download firmware and prepare a local recovery backup.'}`);
    activity.finish(0,'Device connected');
    actions(recoveryPlan?'restore':'prepare','finish');
  }catch(e){try{await connection?.close();}catch{}connection=null;identity=null;status('Connection not completed',errorMessage(e),'error');activity.fail();actions('connect');}
  finally{lock(false);}
};
$('prepare').onclick=async()=>{
  if(busy||!connection||!identity)return;lock(true);actions();activity.start('download','Downloading firmware');status('Checking firmware','Downloading the pinned release and checking its SHA-256 hashes.');
  try { const files=await fetchFiles(release,fetch,status,onEvent); status('Download verified','Checking the connected flash.'); plan=await prepare(connection.loader,release,device,identity,files,()=>{},onEvent);
    activity.finish(1,'Firmware and backup checked');
    if(!plan.ranges.length){status('This version is already installed',`Every selected firmware range matches ${release.version}. No flash was written.`);actions('finish');}
    else {status('Recovery backup prepared',`${plan.ranges.length} changed flash ${plan.ranges.length===1?'range':'ranges'} verified and backed up in this browser. Save the recovery file to enable installation.`);$('replace-warning').textContent=plan.replacingMap && release.project === 'blackjack'?'Blackjack replaces the partition map and application. Existing NVS and exact compatible Blackjack journals are preserved; newly claimed journal regions are backed up and initialized.':plan.replacingMap?'This replaces the current partition layout and application. The NVS region is skipped; saved settings may not transfer between projects.':'The matching device layout is retained. Only changed ranges will be written.';actions('save','finish');}
  }catch(e){plan=null;try{await connection?.close(true);}catch{}connection=null;identity=null;status('Preparation stopped',errorMessage(e)+' No flash was written. Reconnect before trying again.','error');activity.fail();actions('connect');}
  finally{lock(false);}
};
$('save').onclick=async()=>{
  if(busy||!plan)return;
  const name=`${device.id}-recovery.bflash`;
  // Obtain the save handle during the gesture, before generating the backup bytes.
  const handlePromise=window.showSaveFilePicker?window.showSaveFilePicker({suggestedName:name,types:[{description:'Firmware recovery backup',accept:{'application/octet-stream':['.bflash']}}]}):null;
  lock(true);activity.start('save','Saving recovery backup');
  try{const handle=handlePromise?await handlePromise:null;const bytes=await encodeBackup(plan);
    if(handle){const writer=await handle.createWritable();await writer.write(bytes);await writer.close();saved=true;activity.finish(2,'Recovery backup saved');status('Backup saved','The recovery file was written to your computer. You can now install.');actions('install','save','finish');}
    else{const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}));const a=link('',url);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);$('saved-check').hidden=false;activity.finish(1,'Confirm the recovery download');activity.step(2);status('Recovery download requested','Keep the .bflash file, then confirm below that it finished saving.');actions('install','save','finish');}
  }catch(e){activity.fail();status(e.name==='AbortError'?'Backup save cancelled':'Backup could not be saved',e.name==='AbortError'?'Save the recovery file before installing.':errorMessage(e),'error');}
  finally{lock(false);}
};
$('backup-confirm').onchange=()=>{saved=$('backup-confirm').checked;if(!busy)$('install').disabled=!saved;if(saved){activity.finish(2,'Recovery download confirmed');status('Backup confirmed','You confirmed the recovery file finished saving.');}else{activity.step(2);activity.log.add('Recovery download confirmation cleared.');}};
$('install').onclick=async()=>{
  if(busy||!saved||!plan||!plan.ranges.length)return;lock(true);mutating=true;actions();activity.start('write','Checking device before flashing');
  try{const result=await installTransaction(connection.loader,plan,()=>connection.identify(),()=>{},onEvent);
    if(result.installed){activity.finish(3,'Flash written and verified');status('Installed & verified','All written ranges match. Restart the device, then check its display and buttons.','success');}
    else{activity.fail();status('Previous firmware restored','The install failed; the original sectors were restored and verified. Keep the recovery file.','warning');}
    actions('finish');
  }catch(e){resetOnClose=false;status('Installation stopped',errorMessage(e),'error');activity.fail();actions('finish');}
  finally{mutating=false;lock(false);}
};
$('restore').onclick=async()=>{
  if(busy||!recoveryPlan||!connection)return;lock(true);mutating=true;actions();activity.start('restore','Checking recovery backup');
  try{await restoreTransaction(connection.loader,recoveryPlan,device,()=>connection.identify(),()=>{},onEvent);activity.finish(3,'Recovery written and verified');status('Recovery verified','The saved flash sectors match the connected device. Restart and check its display.','success');actions('finish');}
  catch(e){resetOnClose=false;status('Recovery not verified',errorMessage(e)+' Keep your recovery file and reconnect in flashing mode.','error');activity.fail();actions('finish');}
  finally{mutating=false;lock(false);}
};
async function disconnectAndClose(){if(busy)return;lock(true);try{await connection?.close(resetOnClose);}catch{status('USB disconnected','Reconnect or press reset to restart the device.');}finally{connection=null;identity=null;plan=null;recoveryPlan=null;lock(false);$('installer').close();}}
$('finish').onclick=disconnectAndClose;$('close-dialog').onclick=disconnectAndClose;
$('installer').addEventListener('cancel',e=>{e.preventDefault();if(!busy)disconnectAndClose();});
$('recovery-open').onclick=()=>{if(!busy&&!connection)$('backup-file').click();};
$('backup-file').onchange=async()=>{
  const file=$('backup-file').files[0];$('backup-file').value='';if(!file)return;
  try{requireThat(file.size<9*1024*1024,'Recovery file is too large.');const recovered=await decodeBackup(new Uint8Array(await file.arrayBuffer()),catalog);const archived=[...catalog.releases,...(catalog.recoveryReleases||[])];$('catalog-error').hidden=true;openInstaller(archived.find(r=>r.id===recovered.release&&r.device===recovered.device),recovered);}
  catch(e){$('catalog-error').hidden=false;$('catalog-error').textContent='Recovery file not accepted: '+errorMessage(e)+' No flash was written.';}
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
