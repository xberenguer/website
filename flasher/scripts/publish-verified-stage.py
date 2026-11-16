#!/usr/bin/env python3
"""Publish exactly five verified signed-flasher files through GitHub Git Data.

Uses gh api's existing authentication, never retrieves a token. No local commit,
force push, rebase, key access, permission change, or automatic write retry.
"""
import argparse,base64,copy,datetime,hashlib,importlib.util,json,re,shutil,subprocess,sys,tempfile
from pathlib import Path
sys.dont_write_bytecode=True
REPO='xberenguer/website';API='repos/'+REPO
BOT={'name':'github-actions[bot]','email':'41898282+github-actions[bot]@users.noreply.github.com'}
class Invalid(ValueError):pass
class ApiError(RuntimeError):
 def __init__(self,method,path,status=None):
  self.method,self.path,self.status=method,path,status
  super().__init__('GitHub REST '+method+' '+path+' failed'+(' (HTTP '+str(status)+')'if status else' (transport/result uncertain)'))
def need(ok,message):
 if not ok:raise Invalid(message)
def sha(data):return hashlib.sha256(data).hexdigest()
def git_blob(data):return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()
def is_sha(x):return isinstance(x,str)and re.fullmatch('[0-9a-f]{40}',x)is not None
def git(root,*args):
 r=subprocess.run(['git','-C',str(root),*args],capture_output=True,timeout=30);need(r.returncode==0,'Local Git read failed: '+args[0]);return r.stdout

def read_regular(root,name,limit):
 p=root/name;need(not Path(name).is_absolute()and '..'not in Path(name).parts,'Unsafe file path')
 need(all(not q.is_symlink()for q in [p,*p.parents]if q.is_relative_to(root)),'Symlink in verified file path')
 need(p.is_file()and 0<p.stat().st_size<=limit,'Missing/oversized verified file: '+name);return p.read_bytes()
def consumer(root):
 p=root/'flasher/scripts/consume-phoenix.py';spec=importlib.util.spec_from_file_location('publisher_consumer',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def tree_hash(entries):
 root={}
 for name,(mode,oid)in entries.items():
  parts=name.split('/');d=root
  for component in parts[:-1]:
   need(component not in d or isinstance(d[component],dict),'Tree file/directory conflict');d=d.setdefault(component,{})
  need(parts[-1]not in d,'Duplicate Git tree path');d[parts[-1]]=(mode,oid)
 def digest(d):
  records=[]
  for name,value in d.items():
   if isinstance(value,dict):mode,oid='40000',digest(value);key=name.encode()+b'/'
   else:mode,oid=value;key=name.encode()
   records.append((key,mode.encode()+b' '+name.encode()+b'\0'+bytes.fromhex(oid)))
  body=b''.join(x[1]for x in sorted(records,key=lambda x:x[0]));return hashlib.sha1(b'tree '+str(len(body)).encode()+b'\0'+body).hexdigest()
 return digest(root)
def base_entries(root):
 out={}
 for item in git(root,'ls-tree','-r','-z','--full-tree','HEAD').split(b'\0'):
  if not item:continue
  fields,name=item.split(b'\t',1);mode,kind,oid=fields.decode().split();need(kind in('blob','commit')and is_sha(oid),'Unsupported Git tree item');out[name.decode('utf8')]=(mode.lstrip('0'),oid)
 return out
def dirty_paths(root):
 paths=[]
 for item in git(root,'status','--porcelain=v1','-z','--untracked-files=all').split(b'\0'):
  if not item:continue
  status=item[:2].decode();need(not any(x in status for x in'RCDU'),'Renamed/deleted/conflicted paths are not allowed');need(item[2:3]==b' ','Unexpected Git status');paths.append(item[3:].decode('utf8'))
 return paths

def validate_local(root,stage,node):
 root=Path(root).resolve();stage=Path(stage).resolve();need(not stage.is_relative_to(root),'Stage must be external to checkout')
 need(Path(git(root,'rev-parse','--show-toplevel').decode().strip()).resolve()==root,'Use the repository root checkout')
 base=git(root,'rev-parse','--verify','HEAD').decode().strip();need(is_sha(base),'Expected an existing SHA1 checkout commit')
 C=consumer(root);S=C.S;plan=C.strict_json(read_regular(stage,'PLAN.json',1048576));need(plan.get('status')=='SIGNED_VERIFIED_STAGE_NOT_APPLIED'and plan.get('signatureIncluded')is True,'Expected the signed consumer stage')
 need(plan.get('repository')==C.REPO and plan.get('keyFingerprint')==C.KEY_FINGERPRINT,'Wrong signed stage origin/key')
 raw=read_regular(stage,'flasher/catalog.json',1048576);sig=read_regular(stage,'flasher/catalog.sig',64);need(len(sig)==64,'Invalid signature size');need(plan.get('catalogSHA256')==sha(raw)and plan.get('signatureSHA256')==sha(sig),'Stage catalog/signature hash mismatch')
 incoming=C.strict_json(raw);current=C.strict_json(git(root,'show','HEAD:flasher/catalog.json'));_,old=S.active(current);_,new=S.active(incoming)
 need(S.version(new['version'])>S.version(old['version']),'Publisher requires a newer Phoenix release')
 version=new['version'];need(re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',version)is not None and '.'.join(map(str,S.version(version)))==version,'Expected a canonical stable release version');need(new['id']=='phoenix-sticks3-'+version,'Unexpected Phoenix release ID');expected={'flasher/catalog.json','flasher/catalog.sig','flasher/firmware/SHA256SUMS','flasher/firmware/phoenix-confucius-sticks3-'+version+'.bin','flasher/firmware/phoenix-confucius-assets-'+version+'.bin'}
 rows=plan.get('copyAllowlist');need(isinstance(rows,list)and len(rows)==5 and{r.get('path')for r in rows}==expected,'Stage must allow exactly catalog/signature/checksums/two versioned binaries')
 need(len({r['path']for r in rows})==5,'Duplicate stage path');payload={}
 limits={'flasher/catalog.json':1048576,'flasher/catalog.sig':64,'flasher/firmware/SHA256SUMS':65536}
 for row in rows:
  name=row['path'];data=read_regular(stage,name,limits.get(name,0x800000));need(type(row.get('bytes'))is int and row['bytes']==len(data)and row.get('sha256')==sha(data),'Stage payload tampered: '+name)
  need(read_regular(root,name,limits.get(name,0x800000))==data,'Applied checkout differs from verified stage: '+name);need(not((root/name).stat().st_mode&0o111),'Payload must not be executable');payload[name]=data
 need(set(dirty_paths(root))<=expected,'Checkout contains unexpected changed/untracked files')
 # The old signature and all old validators/files must match the exact parent,
 # rather than trusting absolute dependency paths recorded by another runner.
 C.verify_signature(root/'flasher',git(root,'show','HEAD:flasher/catalog.json'),git(root,'show','HEAD:flasher/catalog.sig'))
 C.verify_signature(root/'flasher',raw,sig)
 base_inputs=plan.get('baseInputs');need(isinstance(base_inputs,dict),'Missing parent input pins')
 required={'catalog.json','catalog.sig','release-key.pem','package.json','firmware/SHA256SUMS',*C.validator_modules(root/'flasher')}
 for release in current['releases']+current.get('recoveryReleases',[]):
  for f in release['files']:required.add(f['url'])
 need(required<=base_inputs.keys(),'Incomplete parent file/validator binding')
 for name,h in base_inputs.items():
  need(isinstance(name,str)and not Path(name).is_absolute()and '..'not in Path(name).parts,'Unsafe parent input path');need(re.fullmatch('[0-9a-f]{64}',h)is not None,'Invalid parent input hash');need(sha(git(root,'show','HEAD:flasher/'+name))==h,'Stage was built against another parent snapshot')
 # This is the exact signed consumer transition, including unchanged Seeder,
 # project/device metadata and preserved old Phoenix recovery contract.
 validate_catalog_change(C,current,incoming,new)
 need(new['partitions']==S.MAP and new['project']=='phoenix'and new['device']=='sticks3','Unexpected Phoenix target map')
 app=payload['flasher/firmware/phoenix-confucius-sticks3-'+version+'.bin'];assets=payload['flasher/firmware/phoenix-confucius-assets-'+version+'.bin']
 need(new['files']==[{'id':n,'url':'firmware/'+n,'bytes':len(b),'sha256':S.sha(b)}for n,b in(('phoenix-confucius-sticks3-'+version+'.bin',app),('phoenix-confucius-assets-'+version+'.bin',assets))],'Signed firmware metadata differs from applied bytes')
 lengths=[(0,0x8000,0,'bootloader'),(0x8000,0x1000,0x8000,'partitions'),(0xe000,0x2000,0xe000,'ota'),(0x10000,len(app)-0x10000,0x10000,'application')]
 ap=new['files'][0]['id'];fp=new['files'][1]['id'];parts=[{'file':ap,'sourceOffset':o,'length':n,'address':a,'kind':k}for o,n,a,k in lengths]+[{'file':fp,'sourceOffset':0,'length':len(assets),'address':0x670000,'kind':'assets'}];need(new['parts']==parts and len(assets)==0x180000,'Signed flash slices differ from bounded contract')
 S.image(app,0,0x8000);S.image(app,0x10000,len(app));need(len(app)<=0x670000,'Application exceeds partition');need(all(b==255 for b in app[0x9000:0xe000]),'Non-erased distribution NVS')
 # Re-run the actual pinned-key Node core over the applied signed catalog and
 # all active/recovery files; local checksum authority is checked too.
 C.current_state(root/'flasher',node)
 need(payload['flasher/firmware/SHA256SUMS']==S.local_sums(git(root,'show','HEAD:flasher/firmware/SHA256SUMS'),new),'Checksum update modifies retained entries')
 entries=base_entries(root);old_tree=git(root,'rev-parse','HEAD^{tree}').decode().strip();need(tree_hash(entries)==old_tree,'Local tree reconstruction mismatch')
 next_entries=dict(entries)
 for name,data in payload.items():next_entries[name]=('100644',git_blob(data))
 return {'root':root,'stage':stage,'base':base,'base_tree':old_tree,'payload':payload,'expected_paths':expected,'tree':tree_hash(next_entries),'version':version,'planSHA256':sha((stage/'PLAN.json').read_bytes())}

def validate_catalog_change(C,before,after,new):
 C.S.validate_transition(before,after,new)
 index,old=C.S.active(before);expected=copy.deepcopy(before);expected['releases'][index]=copy.deepcopy(new);archive=expected.setdefault('recoveryReleases',[])
 if old['id']!=new['id']and not any(r['id']==old['id']for r in archive):archive.append(copy.deepcopy(old))
 need(C.semantic_equal(after,expected),'Signed catalog changes protected values or JSON types')

def recheck(local):
 need(git(local['root'],'rev-parse','HEAD').decode().strip()==local['base'],'Checkout HEAD changed during publication');need(set(dirty_paths(local['root']))<=local['expected_paths'],'Checkout changed during publication')
 need(sha((local['stage']/'PLAN.json').read_bytes())==local['planSHA256'],'Stage plan changed during publication')
 for name,data in local['payload'].items():need(read_regular(local['root'],name,0x800000)==data and read_regular(local['stage'],name,0x800000)==data,'Verified bytes changed during publication')
class GhApi:
 def request(self,method,path,data=None):
  need(path.startswith(API+'/git/'),'Unexpected API target');command=['gh','api','--hostname','github.com','--method',method,'-H','Accept: application/vnd.github+json','-H','X-GitHub-Api-Version: 2022-11-28',path]
  if data is not None:command+=['--input','-']
  try:r=subprocess.run(command,input=None if data is None else json.dumps(data).encode(),capture_output=True,timeout=90)
  except subprocess.TimeoutExpired:raise ApiError(method,path)
  if r.returncode:
   m=re.search(rb'HTTP\s+(\d{3})',r.stderr);raise ApiError(method,path,int(m[1])if m else None)
  need(len(r.stdout)<=8388608,'API response exceeds size budget')
  try:return json.loads(r.stdout)
  except ValueError:raise ApiError(method,path)
def head(api):
 response=api.request('GET',API+'/git/ref/heads/main');need(response.get('ref')=='refs/heads/main'and response.get('object',{}).get('type')=='commit'and is_sha(response['object'].get('sha')),'Invalid main ref response');return response['object']['sha']
def publish(local,api):
 need(head(api)==local['base'],'Remote main changed; no API objects were written')
 parent=api.request('GET',API+'/git/commits/'+local['base']);need(parent.get('sha')==local['base']and parent.get('tree',{}).get('sha')==local['base_tree'],'Remote/local base commit tree differs')
 recheck(local);tree=[]
 for name,data in sorted(local['payload'].items()):
  expected=git_blob(data);created=api.request('POST',API+'/git/blobs',{'encoding':'base64','content':base64.b64encode(data).decode('ascii')});need(created.get('sha')==expected,'API blob SHA differs from exact verified bytes');tree.append({'path':name,'mode':'100644','type':'blob','sha':expected})
 created=api.request('POST',API+'/git/trees',{'base_tree':local['base_tree'],'tree':tree});need(created.get('sha')==local['tree'],'API tree differs from exact inherited-root/5-file tree')
 now=datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat();identity={**BOT,'date':now};message='Sync Phoenix firmware '+local['version']+' from signed release'
 commit=api.request('POST',API+'/git/commits',{'message':message,'tree':local['tree'],'parents':[local['base']],'author':identity,'committer':identity});need(is_sha(commit.get('sha'))and commit.get('tree',{}).get('sha')==local['tree']and[p.get('sha')for p in commit.get('parents',[])]==[local['base']],'API commit has another tree or parent')
 recheck(local);need(head(api)==local['base'],'Remote main changed before ref update; objects remain unattached')
 try:updated=api.request('PATCH',API+'/git/refs/heads/main',{'sha':commit['sha'],'force':False})
 except ApiError as error:
  # No retry/rollback: a transport timeout may have applied the ref update.
  raise ApiError('PATCH',error.path,error.status)
 need(updated.get('ref')=='refs/heads/main'and updated.get('object',{}).get('sha')==commit['sha'],'Ref response did not confirm the new commit; do not retry automatically')
 return {'status':'REF_UPDATE_ACKNOWLEDGED','repository':REPO,'parent':local['base'],'tree':local['tree'],'commit':commit['sha'],'paths':sorted(local['payload']),'force':False,'transport':'GitHub REST via existing gh authentication','pagesBuildRequested':False}
def main(argv=None):
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--stage',type=Path,required=True);p.add_argument('--root',type=Path,default=Path.cwd());p.add_argument('--repo',choices=[REPO],default=REPO);p.add_argument('--node',default=shutil.which('node'));a=p.parse_args(argv)
 try:need(a.node is not None,'Node22+ is required');local=validate_local(a.root,a.stage,a.node);result=publish(local,GhApi());print(json.dumps(result,indent=2));return 0
 except(ApiError,Invalid,OSError,ValueError,KeyError,subprocess.TimeoutExpired)as error:
  print('Verified-stage REST publisher stopped: '+str(error),file=sys.stderr)
  if isinstance(error,ApiError)and error.method=='PATCH':print('No automatic retry. A transport timeout can leave ref status uncertain; HTTP403/409/422 is not a successful publication.',file=sys.stderr)
  return 1
if __name__=='__main__':sys.exit(main())
