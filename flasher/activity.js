// Local, bounded installation activity. No application serial monitor or uploads.
export { observe, hexAddress } from './events.js';
export function formatBytes(n) {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1048576) return `${(n/1024).toFixed(1)} KiB`;
  return `${(n/1048576).toFixed(2)} MiB`;
}
export function cleanText(value) {
  return String(value).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'')
    .replace(/\r\n/g,'\n').replace(/\r/g,'\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'')
    .replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi,'[device address]');
}
export class ActivityLog {
  constructor({now=()=>performance.now(),limit=600,onChange=()=>{}}={}) { this.now=now;this.limit=limit;this.onChange=onChange;this.reset(); }
  reset() { this.started=this.now();this.lines=[];this.pending='';this.dropped=0;this.onChange(); }
  add(message,level='info',source='FLASHER') {
    for(const text of cleanText(message).split('\n')) {
      if(!text.trim())continue;
      this.lines.push({seconds:Math.max(0,(this.now()-this.started)/1000),level,source,text:text.slice(0,4096)});
    }
    if(this.lines.length>this.limit){this.dropped+=this.lines.length-this.limit;this.lines.splice(0,this.lines.length-this.limit);}
    this.onChange();
  }
  terminal(value,newline=false) {
    const text=this.pending+cleanText(value)+(newline?'\n':'');const rows=text.split('\n');
    this.pending=rows.pop().slice(-4096);for(const line of rows)this.add(line,'info','ESPTOOL');
  }
  flush(){if(this.pending){this.add(this.pending,'info','ESPTOOL');this.pending='';}}
  text(){return (this.dropped?`[${this.dropped} older lines omitted]\n`:'')+this.lines.map(r=>`[${r.seconds.toFixed(3).padStart(7,'0')}s] ${r.level==='error'?'ERROR ':r.level==='warning'?'WARN ':''}${r.source.padEnd(7)} ${r.text}`).join('\n')+(this.pending?'\nESPTOOL '+this.pending:'');}
}
export class ActivityPanel {
  constructor(doc=document) {
    this.doc=doc;this.$=id=>doc.getElementById(id);this.log=new ActivityLog({onChange:()=>this.schedule()});this.rows=new Map();this.milestones=new Map();this.active=false;
    this.$('copy-log').onclick=async()=>{try{await navigator.clipboard.writeText(this.log.text());this.$('log-feedback').textContent='Copied';}catch{this.$('log-feedback').textContent='Use Download log';}};
    this.$('download-log').onclick=()=>{const url=URL.createObjectURL(new Blob([this.log.text()+'\n'],{type:'text/plain;charset=utf-8'}));const a=doc.createElement('a');a.href=url;a.download=this.filename||'flasher-activity.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);this.$('log-feedback').textContent='Log downloaded';};
    const out=this.$('activity-log');this.follow=true;
    for(const name of ['wheel','pointerdown','keydown'])out.addEventListener(name,()=>{this.follow=false;},{passive:true});
    out.addEventListener('scroll',()=>{if(out.scrollHeight-out.scrollTop-out.clientHeight<40)this.follow=true;});
    this.resize=new ResizeObserver(()=>{if(this.follow)out.scrollTop=out.scrollHeight;});this.resize.observe(out);
    this.timer=setInterval(()=>{if(this.active)this.renderTime();},1000);
  }
  schedule(){if(this.scheduled)return;this.scheduled=true;requestAnimationFrame(()=>{this.scheduled=false;this.renderLog();});}
  renderLog(){const out=this.$('activity-log');out.textContent=this.log.text();if(this.follow)out.scrollTop=out.scrollHeight;}
  renderTime(){const secs=Math.floor((performance.now()-this.log.started)/1000);this.$('activity-elapsed').textContent=`Elapsed ${String(Math.floor(secs/60)).padStart(2,'0')}:${String(secs%60).padStart(2,'0')}`;}
  reset(release,restore=false){
    this.restore=restore;this.follow=true;this.phase=null;this.active=false;this.log.reset();this.rows.clear();this.milestones.clear();this.$('transfer-progress').replaceChildren();this.$('log-feedback').textContent='';this.$('activity-elapsed').textContent='Elapsed 00:00';
    this.filename=`${release.id}-activity.txt`;this.$('progress').value=0;this.$('progress').hidden=false;this.$('progress-value').textContent='Ready';this.$('progress-label').textContent='Waiting for connection';this.$('status-box').dataset.state='ready';this.$('activity-state').textContent='Ready';
    const names=restore?['Connect','Check backup','Restore','Verify']:['Connect','Prepare','Save backup','Flash & verify'];
    this.$('install-steps').replaceChildren(...names.map((name,i)=>{const li=this.doc.createElement('li');li.dataset.state=i===0?'current':'waiting';li.textContent=`${i+1}  ${name}`;if(i===0)li.setAttribute('aria-current','step');return li;}));
    this.log.add(`${restore?'Recovery':'Install'} session · ${release.project} · ${release.version}`);
    this.log.add('Release catalogue signature verified. USB connection required before preparation.');
  }
  step(index,done=false){
    [...this.$('install-steps').children].forEach((li,i)=>{li.dataset.state=i<index||i===index&&done?'done':i===index?'current':'waiting';li.removeAttribute('aria-current');if(i===index&&!done)li.setAttribute('aria-current','step');});
  }
  start(phase,label){this.operation=phase;this.phase=null;this.active=true;this.$('activity-state').textContent='Live';this.$('status-box').dataset.state='busy';this.event({type:'progress',phase,label});}
  finish(step,label){this.active=false;this.log.flush();this.step(step,true);this.$('progress').value=1;this.$('progress-value').textContent='100%';this.$('progress-label').textContent=label;this.$('status-box').dataset.state='success';this.$('activity-state').textContent=step===3?'Complete':'Ready';this.renderTime();}
  fail(){this.active=false;this.log.flush();this.$('status-box').dataset.state='error';this.$('activity-state').textContent='Stopped';const current=this.$('install-steps').querySelector('[aria-current]');if(current)current.dataset.state='error';this.renderTime();}
  event(event){
    if(event.type==='terminal'){this.log.terminal(event.text,event.newline);return;}
    if(event.type==='log'){this.log.add(event.message,event.level||'info',event.source||'FLASHER');return;}
    if(event.type!=='progress')return;
    const {phase,label,done,total,id,overallDone=done,overallTotal=total}=event;
    const now=performance.now();if(phase===this.phase&&label===this.progressLabel&&this.rows.has(id)&&done<total&&now-(this.lastPaint||0)<50)return;
    this.lastPaint=now;this.progressLabel=label;
    if(phase!==this.phase){this.phase=phase;this.rows.clear();this.$('transfer-progress').replaceChildren();this.milestones.clear();this.log.flush();this.log.add(label);}
    const step=this.restore?({connect:0,check:1,restore:2,write:2,verify:3,rollback:2}[phase]):({connect:0,download:1,check:1,backup:1,save:2,write:3,verify:3,rollback:3}[phase]);
    if(phase==='check'&&this.operation==='write')this.step(3);else if(step!==undefined)this.step(step);
    this.$('progress-label').textContent=({connect:'USB connection',download:'Download progress',check:'Checking',backup:'Backup progress',save:'Saving backup',write:'Transfer progress',verify:'Verification progress',rollback:'Recovery progress',restore:'Restore progress'})[phase]||label;
    const bar=this.$('progress');bar.hidden=false;
    if(Number.isFinite(overallTotal)&&overallTotal>0&&Number.isFinite(overallDone)){
      const fraction=Math.max(0,Math.min(1,overallDone/overallTotal));bar.value=fraction;this.$('progress-value').textContent=`${Math.floor(fraction*100)}%`;
    }else{bar.removeAttribute('value');this.$('progress-value').textContent='Working…';}
    if(id&&Number.isFinite(total)&&total>0){
      let row=this.rows.get(id);
      if(!row){const box=this.doc.createElement('div');box.className='transfer-row';const name=this.doc.createElement('span'),amount=this.doc.createElement('small'),progress=this.doc.createElement('progress');name.textContent=id;progress.max=total;progress.setAttribute('aria-label',label+' '+id);box.append(name,amount,progress);this.$('transfer-progress').append(box);row={amount,progress};this.rows.set(id,row);}
      row.progress.value=Math.min(total,done);row.amount.textContent=event.unit==='ranges'?(done===total?'Verified':'Checking…'):`${formatBytes(done)} / ${formatBytes(total)}`;
      const milestone=Math.floor(done/total*4);
      if(milestone>(this.milestones.get(id)??-1)){this.milestones.set(id,milestone);this.log.add(`${id} · ${Math.floor(done/total*100)}% · ${row.amount.textContent}`, 'info',phase==='download'?'DOWNLOAD':phase==='verify'?'VERIFY':'FLASH');}
    }
  }
}
