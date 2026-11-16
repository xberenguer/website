#!/usr/bin/env python3
"""Validate the latest published Phoenix firmware and stage an UNSIGNED update.

No checkout writes, signing keys, Git operations, device access or browser GitHub
fetches. Root's local release workflow must sign, test and publish the stage.
Python 3.10+ and Node 22+; no Python packages or npm installation required.
"""
import argparse,copy,datetime,hashlib,json,os,re,shutil,struct,subprocess,sys,tempfile,urllib.request,urllib.parse
from pathlib import Path
REPO='xberenguer/phoenix-link-confucius-say'
WEB='https://github.com/'+REPO
API='https://api.github.com/repos/'+REPO
APP='phoenix-confucius-sticks3.bin'
ASSETS='feature-assets.bin'
SUMS='SHA256SUMS.txt'
CAPACITY=0x800000
MAP=[{'type':1,'subtype':2,'offset':0x9000,'size':0x5000,'label':'nvs','flags':0},
 {'type':1,'subtype':0,'offset':0xe000,'size':0x2000,'label':'otadata','flags':0},
 {'type':0,'subtype':16,'offset':0x10000,'size':0x660000,'label':'app0','flags':0},
 {'type':1,'subtype':130,'offset':0x670000,'size':0x180000,'label':'spiffs','flags':0},
 {'type':1,'subtype':3,'offset':0x7f0000,'size':0x10000,'label':'coredump','flags':0}]
class Invalid(ValueError):pass
def need(ok,message):
 if not ok:raise Invalid(message)
def sha(data):return hashlib.sha256(data).hexdigest()
def nodup(pairs):
 d={}
 for k,v in pairs:
  need(k not in d,'Duplicate JSON field: '+k);d[k]=v
 return d
def parse_json(data):return json.loads(data,object_pairs_hook=nodup)
def version(text,tag=False):
 p=r'v(\d+)\.(\d+)\.(\d+)'if tag else r'(\d+)\.(\d+)\.(\d+)(?: candidate)?'
 m=re.fullmatch(p,text or '');need(m is not None,'Expected a numeric stable version: '+str(text));need(all(str(int(x))==x for x in m.groups()),'Noncanonical version');return tuple(map(int,m.groups()))
def release_metadata(meta):
 need(isinstance(meta,dict)and meta.get('draft')is False and meta.get('prerelease')is False,'Only stable published releases are eligible')
 tag=meta.get('tag_name');v=version(tag,True);need(meta.get('html_url')==WEB+'/releases/tag/'+tag,'Release belongs to another repository/tag')
 need(type(meta.get('id'))is int and meta['id']>0,'Missing release ID')
 try:published=datetime.datetime.fromisoformat(meta['published_at'].replace('Z','+00:00'))
 except (KeyError,ValueError,AttributeError):raise Invalid('Missing publication time')
 need(published.tzinfo is not None,'Publication time must have a timezone')
 selected={}
 for name,limit in((APP,0x670000),(ASSETS,0x180000),(SUMS,65536)):
  rows=[a for a in meta.get('assets',[])if a.get('name')==name];need(len(rows)==1,'Missing or duplicate release asset: '+name);a=rows[0]
  need(a.get('browser_download_url')==WEB+'/releases/download/'+tag+'/'+name,'Asset is not pinned to the expected repository/tag')
  need(type(a.get('id'))is int and a['id']>0 and type(a.get('size'))is int and 0<a['size']<=limit,'Invalid asset ID/size: '+name)
  if a.get('digest')is not None:need(re.fullmatch(r'sha256:[0-9a-f]{64}',a['digest'])is not None,'Invalid GitHub asset digest')
  selected[name]=a
 return tag,v,selected
def release_pin(meta):
 tag,v,a=release_metadata(meta);return {'release':meta['id'],'tag':tag,'published':meta['published_at'],'assets':{n:{k:x.get(k)for k in('id','size','digest','browser_download_url')}for n,x in a.items()}}
class Redirects(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):
  u=urllib.parse.urlsplit(newurl);need(u.scheme=='https'and u.hostname in('github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'),'Unexpected download redirect host')
  return super().redirect_request(req,fp,code,msg,headers,newurl)
def download(url,limit):
 opener=urllib.request.build_opener(Redirects());request=urllib.request.Request(url,headers={'User-Agent':'Phoenix-Flasher-Sync/1','Accept':'application/vnd.github+json'if url.startswith(API)else'application/octet-stream'})
 with opener.open(request,timeout=25)as response:
  data=response.read(limit+1);need(len(data)<=limit,'Download exceeds size limit');return data
def sums(data):
 need(len(data)<=65536,'Checksum file too large');out={}
 for line in data.decode('ascii').splitlines():
  if not line.strip():continue
  m=re.fullmatch(r'([0-9a-fA-F]{64}) [ *]([A-Za-z0-9._-]+)',line);need(m is not None,'Malformed SHA256SUMS entry');h,name=m.groups();need(name not in out,'Duplicate checksum filename');out[name]=h.lower()
 return out
def image(data,start,limit):
 need(start+24<=limit<=len(data),'Image outside its allowed slice');need(data[start]==0xe9 and 1<=data[start+1]<=16,'Invalid ESP image header')
 need(struct.unpack_from('<H',data,start+12)[0]==9,'Firmware is not ESP32-S3');need(data[start+3]>>4==3,'Image header does not declare 8MB flash');need(data[start+23]in(0,1),'Invalid image digest flag')
 at=start+24;check=0xef
 for _ in range(data[start+1]):
  need(at+8<=limit,'Truncated segment header');_,size=struct.unpack_from('<II',data,at);at+=8;need(size>0 and at+size<=limit,'Truncated/empty ESP segment')
  for x in data[at:at+size]:check^=x
  at+=size
 end=(at//16+1)*16;need(end<=limit and data[end-1]==check,'ESP image checksum mismatch')
 if data[start+23]:need(end+32<=limit and data[end:end+32]==hashlib.sha256(data[start:end]).digest(),'ESP image appended SHA mismatch');end+=32
 return end
def validate_downloads(meta,blobs):
 tag,v,assets=release_metadata(meta);need(set(blobs)=={APP,ASSETS,SUMS},'Expected only two binaries and checksums');checks=sums(blobs[SUMS])
 for name,data in blobs.items():
  a=assets[name];need(len(data)==a['size'],'Asset length mismatch: '+name)
  if a.get('digest'):need(a['digest']=='sha256:'+sha(data),'GitHub asset digest mismatch: '+name)
  if name!=SUMS:need(checks.get(name)==sha(data),'Release checksum mismatch: '+name)
 merged=blobs[APP];need(0x10100<len(merged)<=0x670000,'Merged firmware does not fit the 8MB application map');need(len(blobs[ASSETS])==0x180000,'Asset image must exactly fill its declared partition')
 bootEnd=image(merged,0,0x8000);appEnd=image(merged,0x10000,len(merged));need(all(x==255 for x in merged[bootEnd:0x8000]),'Unexpected payload after boot image');need(all(x==255 for x in merged[appEnd:]),'Unexpected payload after application')
 need(all(x==255 for x in merged[0x9000:0xe000]),'Merged distribution contains non-erased NVS bytes')
 return tag,v

def active(catalog):
 a=[(i,r)for i,r in enumerate(catalog.get('releases',[]))if r.get('project')=='phoenix'and r.get('device')=='sticks3'];need(len(a)==1,'Expected exactly one active Phoenix StickS3 release');return a[0]
def new_release(meta,blobs):
 tag,v=validate_downloads(meta,blobs);ver=tag[1:];app='phoenix-confucius-sticks3-'+ver+'.bin';asset='phoenix-confucius-assets-'+ver+'.bin'
 files=[{'id':name,'url':'firmware/'+name,'bytes':len(blobs[up]),'sha256':sha(blobs[up])}for name,up in((app,APP),(asset,ASSETS))]
 parts=[{'file':app,'sourceOffset':offset,'length':length,'address':offset,'kind':kind}for offset,length,kind in((0,0x8000,'bootloader'),(0x8000,0x1000,'partitions'),(0xe000,0x2000,'ota'),(0x10000,len(blobs[APP])-0x10000,'application'))]
 parts.append({'file':asset,'sourceOffset':0,'length':len(blobs[ASSETS]),'address':0x670000,'kind':'assets'})
 return {'id':'phoenix-sticks3-'+ver,'project':'phoenix','device':'sticks3','version':ver,'status':'Published firmware','description':'Offline Confucius Say / Phoenix Link-inspired play-money game.','qualification':'Published stable Phoenix firmware. Release hashes, ESP32-S3 images and the 8MB partition contract were checked. Firmware publication does not itself qualify a browser USB installation on hardware.','source':WEB+'/tree/'+tag,'manual':WEB+'/blob/'+tag+'/README.md','files':files,'parts':parts,'partitions':copy.deepcopy(MAP),'upstream':{'repository':REPO,'tag':tag,'releaseId':meta['id'],'assets':{n:{'id':a['id'],'bytes':a['size'],'sha256':sha(blobs[n])}for n,a in release_metadata(meta)[2].items()if n in(APP,ASSETS)}}}
def plan(catalog,meta,blobs):
 need(catalog.get('format')==1,'Unsupported catalog format');index,old=active(catalog);new=new_release(meta,blobs);oldv=version(old['version']);newv=version(new['version']);need(newv>=oldv,'Refusing firmware downgrade')
 # Versioned files are immutable even if GitHub permits asset replacement.
 if newv==oldv:
  for kind in('application','assets'):
   previous=next(p for p in old['parts']if p['kind']==kind);fresh=next(p for p in new['parts']if p['kind']==kind);pf=next(f for f in old['files']if f['id']==previous['file']);nf=next(f for f in new['files']if f['id']==fresh['file']);need((pf['bytes'],pf['sha256'])==(nf['bytes'],nf['sha256']),'Same version has different firmware bytes; publish a new version')
  if 'upstream'in old:need(old['upstream']==new['upstream'],'Same version has changed upstream asset identity')
  return copy.deepcopy(catalog),old,False
 out=copy.deepcopy(catalog);out['releases'][index]=new;archive=out.setdefault('recoveryReleases',[]);duplicates=[r for r in archive if r['id']==old['id']];need(not duplicates or duplicates==[old],'Recovery release ID collision')
 if not duplicates:archive.append(copy.deepcopy(old))
 need(not any(r['id']==new['id']for r in archive),'New release is already archived; refusing replay')
 # Independent structural delta gate usable by a later signed consumer.
 validate_transition(catalog,out,new)
 return out,new,True
def validate_transition(before,after,new):
 index,old=active(before);i,actual=active(after);need(i==index and actual==new,'Phoenix active selection changed unexpectedly')
 expected=copy.deepcopy(before);expected['releases'][index]=copy.deepcopy(new);archive=expected.setdefault('recoveryReleases',[])
 if old['id']!=new['id']and not any(r['id']==old['id']for r in archive):archive.append(copy.deepcopy(old))
 need(after==expected,'Catalog delta changes another project/device/recovery contract')
def check_node(node,root,operation,*args):
 helper=Path(__file__).with_name('check-phoenix.mjs');cmd=[node,str(helper),str(root),operation,*map(str,args)];r=subprocess.run(cmd,capture_output=True,text=True,timeout=60);need(r.returncode==0,'Existing flasher contract failed: '+r.stderr.strip()[-1500:]);return parse_json(r.stdout)
def local_sums(old,new):
 text=old.decode('ascii');seen={}
 for line in text.splitlines():
  if not line.strip():continue
  m=re.fullmatch(r'([0-9a-fA-F]{64}) [ *]([A-Za-z0-9._-]+)',line);need(m is not None,'Malformed local SHA256SUMS');need(m[2]not in seen,'Duplicate local checksum');seen[m[2]]=m[1].lower()
 for f in new['files']:
  name=f['id'];need(name not in seen or seen[name]==f['sha256'],'Frozen local filename has another checksum')
  if name not in seen:
   if text and not text.endswith('\n'):text+='\n'
   text+=f['sha256']+'  '+name+'\n'
 return text.encode('ascii')
def write_stage(root,destination,catalog,release,blobs,meta,base):
 destination=destination.resolve();root=root.resolve();need(not destination.is_relative_to(root.parent),'Stage must be outside the website checkout');need(not destination.exists(),'Stage already exists; do not overwrite a review result');destination.parent.mkdir(parents=True,exist_ok=True)
 payload={'flasher/catalog.json':(json.dumps(catalog,indent=2,ensure_ascii=False)+'\n').encode(),'flasher/firmware/SHA256SUMS':local_sums((root/'firmware/SHA256SUMS').read_bytes(),release)}
 for f,up in zip(release['files'],(APP,ASSETS)):
  path=root/f['url'];need(not path.is_symlink(),'Firmware path is a symlink')
  if path.exists():need(path.read_bytes()==blobs[up],'Frozen versioned binary already differs')
  else:payload['flasher/'+f['url']]=blobs[up]
 for name,h in base.items():need(sha((root/name).read_bytes())==h,'Catalog/key inputs changed during preparation')
 with tempfile.TemporaryDirectory(prefix='.phoenix-stage-',dir=destination.parent)as work:
  stage=Path(work)/'payload';stage.mkdir();rows=[]
  for name,data in payload.items():p=stage/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data);rows.append({'path':name,'bytes':len(data),'sha256':sha(data)})
  report={'status':'UNSIGNED_STAGE_REQUIRES_LOCAL_SIGNING','repository':REPO,'release':release_pin(meta),'baseInputs':base,'copyAllowlist':rows,'signatureIncluded':False,'signingRequired':True,'deploymentPerformed':False};(stage/'PLAN.json').write_text(json.dumps(report,indent=2)+'\n');os.replace(stage,destination)
 return report

def main(argv=None):
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--flasher-root',type=Path,default=Path(__file__).resolve().parents[1]);parser.add_argument('--node',default=shutil.which('node'));parser.add_argument('--expected-tag');parser.add_argument('--fixture-dir',type=Path,help='Offline metadata.json plus original three assets; reported as fixture input');group=parser.add_mutually_exclusive_group();group.add_argument('--stage',type=Path);group.add_argument('--check',action='store_true');group.add_argument('--dry-run',action='store_true');args=parser.parse_args(argv)
 try:
  root=args.flasher_root.resolve();need(args.node is not None,'Node 22+ is required (--node path)');base={name:sha((root/name).read_bytes())for name in('catalog.json','catalog.sig','release-key.pem','signing.js','core.js','firmware/SHA256SUMS')};existing=check_node(args.node,root,'existing');catalog=parse_json((root/'catalog.json').read_bytes())
  if args.fixture_dir:
   meta=parse_json((args.fixture_dir/'metadata.json').read_bytes());_,_,assets=release_metadata(meta);blobs={name:(args.fixture_dir/name).read_bytes()for name in assets}
  else:
   meta=parse_json(download(API+'/releases/latest',1048576));tag,_,assets=release_metadata(meta);pinned=parse_json(download(API+'/releases/tags/'+tag,1048576));need(release_pin(meta)==release_pin(pinned),'Latest/tag release identity changed');blobs={name:download(a['browser_download_url'],a['size'])for name,a in assets.items()}
   final=parse_json(download(API+'/releases/tags/'+tag,1048576));need(release_pin(final)==release_pin(meta),'Release assets changed during download')
  tag,_,_=release_metadata(meta);need(args.expected_tag is None or args.expected_tag==tag,'Latest stable release does not match the requested milestone tag');updated,release,changed=plan(catalog,meta,blobs)
  with tempfile.TemporaryDirectory(prefix='phoenix-validate-')as work:
   p=Path(work);(p/'release.json').write_text(json.dumps(release));(p/APP).write_bytes(blobs[APP]);(p/ASSETS).write_bytes(blobs[ASSETS]);incoming=check_node(args.node,root,'incoming',p/'release.json',p/APP,p/ASSETS)
  output={'status':'UPDATE_AVAILABLE'if changed else'UP_TO_DATE','repository':REPO,'tag':tag,'changed':changed,'offlineFixture':args.fixture_dir is not None,'baseCatalogSHA256':base['catalog.json'],'existing':existing,'incoming':incoming,'signingRequired':changed,'deploymentPerformed':False}
  if args.stage and changed:output['stage']=write_stage(root,args.stage,updated,release,blobs,meta,base)
  print(json.dumps(output,indent=2));return 3 if args.check and changed else 0
 except (Invalid,OSError,ValueError,KeyError,StopIteration,subprocess.TimeoutExpired)as error:
  print('Phoenix sync stopped: '+str(error),file=sys.stderr);return 1
if __name__=='__main__':sys.exit(main())
