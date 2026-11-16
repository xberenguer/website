#!/usr/bin/env python3
"""Verify a locally signed Phoenix release bundle and stage it outside checkout.

This consumer NEVER signs or applies files. Network metadata uses authenticated
gh api for the fixed repository; binary requests carry no authentication header.
The publisher uploads flasher-catalog.json plus its raw Ed25519 64-byte signature.
"""
import argparse,hashlib,importlib.util,json,os,shutil,subprocess,sys,tempfile
from pathlib import Path
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('phoenix_sync163',HERE/'sync-phoenix.py')
S=importlib.util.module_from_spec(spec);spec.loader.exec_module(S)
REPO='xberenguer/phoenix-link-confucius-say'
CATALOG='flasher-catalog.json';SIGNATURE='flasher-catalog.sig'
PUBLIC_KEY_HEX='044b1a970af958277f4a742b0f4544526406ac99e00575d25f5bbf0b17b28a7a'
KEY_FINGERPRINT='34568ae48435426bb68028eb6f3bb338a2cba5115c906a33ca26c3592c31c5d4'
SIGNED_LIMITS={CATALOG:1048576,SIGNATURE:64}
need=S.need

def strict_json(data):
 def bad(value):raise S.Invalid('Non-finite JSON number')
 return json.loads(data.decode('utf-8'),object_pairs_hook=S.nodup,parse_constant=bad)

def semantic_equal(a,b):
 # Preserve JSON types: Python's ordinary equality treats True as integer1.
 return json.dumps(a,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False)==json.dumps(b,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False)

def metadata_assets(meta):
 tag,_,original=S.release_metadata(meta);signed={}
 for name,limit in SIGNED_LIMITS.items():
  rows=[a for a in meta.get('assets',[])if a.get('name')==name]
  need(len(rows)<=1,'Duplicate signed bundle asset: '+name)
  if not rows:continue
  a=rows[0];need(type(a.get('id'))is int and a['id']>0,'Invalid signed asset ID')
  need(type(a.get('size'))is int and 0<a['size']<=limit,'Invalid signed asset size')
  if name==SIGNATURE:need(a['size']==64,'Ed25519 signature must be exactly64 bytes')
  need(a.get('browser_download_url')==S.WEB+'/releases/download/'+tag+'/'+name,'Signed asset belongs to another repository/tag')
  digest=a.get('digest');need(digest is None or S.re.fullmatch(r'sha256:[0-9a-f]{64}',digest)is not None,'Invalid signed asset digest')
  signed[name]=a
 return original,signed

def bundle_pin(meta):
 _,signed=metadata_assets(meta)
 return {'original':S.release_pin(meta),'signed':{n:{k:a.get(k)for k in('id','size','digest','browser_download_url')}for n,a in signed.items()}}

def gh_metadata(endpoint):
 need(S.REPO==REPO,'Unexpected sync dependency repository')
 need(endpoint=='releases/latest' or endpoint.startswith('releases/tags/v')and '/'not in endpoint[len('releases/tags/'):],'Unsafe metadata endpoint')
 # gh uses GH_TOKEN in Actions or its existing local keyring authentication.
 # This process never retrieves a token or passes one in argv/public requests.
 r=subprocess.run(['gh','api','--hostname','github.com','repos/'+REPO+'/'+endpoint],capture_output=True,timeout=30)
 need(r.returncode==0,'GitHub metadata request failed (exit '+str(r.returncode)+')')
 need(len(r.stdout)<=1048576,'GitHub metadata exceeds size limit')
 return strict_json(r.stdout)

def verify_signature(root,catalog,signature):
 need(len(catalog)<=SIGNED_LIMITS[CATALOG] and len(signature)==64,'Invalid signed catalog/signature length')
 # Ed25519 SPKI has an exact algorithm prefix and32 raw public-key bytes.
 pem=root/'release-key.pem'
 r=subprocess.run(['openssl','pkey','-pubin','-in',str(pem),'-outform','DER'],capture_output=True,timeout=15)
 need(r.returncode==0,'Cannot read published verification key')
 der=r.stdout;prefix=bytes.fromhex('302a300506032b6570032100')
 need(len(der)==44 and der[:12]==prefix,'Published key is not Ed25519')
 raw=der[12:];need(raw.hex()==PUBLIC_KEY_HEX and S.sha(raw)==KEY_FINGERPRINT,'Published key does not match pinned release key')
 with tempfile.TemporaryDirectory(prefix='phoenix-signature-')as work:
  p=Path(work);(p/'catalog').write_bytes(catalog);(p/'signature').write_bytes(signature)
  r=subprocess.run(['openssl','pkeyutl','-verify','-pubin','-inkey',str(pem),'-rawin','-in',str(p/'catalog'),'-sigfile',str(p/'signature')],capture_output=True,timeout=15)
  need(r.returncode==0,'Incoming catalog signature does not match the pinned release key')

def validator_modules(root):
 pending=['core.js','signing.js'];seen=set()
 while pending:
  name=pending.pop()
  if name in seen:continue
  p=root/name;need(not p.is_symlink()and p.is_file(),'Validator module must be a regular file')
  need(all(not parent.is_symlink()for parent in p.parents if parent.is_relative_to(root)),'Validator path contains a symlink')
  text=p.read_text();need(S.re.search(r'\bimport\s*\(',text)is None,'Dynamic validator imports require review')
  specs=S.re.findall(r'''(?:from\s+|import\s*)['"]([^'"]+)['"]''',text)
  for spec in specs:
   need(spec.startswith('.'),'Nonlocal validator import requires review')
   q=(p.parent/spec).resolve();need(q.is_relative_to(root),'Validator import leaves flasher root');pending.append(str(q.relative_to(root)))
  seen.add(name)
 return sorted(seen)

def current_state(root,node):
 names=['catalog.json','catalog.sig','release-key.pem','package.json','firmware/SHA256SUMS',*validator_modules(root)]
 base={n:S.sha((root/n).read_bytes())for n in names}
 verify_signature(root,(root/'catalog.json').read_bytes(),(root/'catalog.sig').read_bytes())
 existing=S.check_node(node,root,'existing')
 catalog=strict_json((root/'catalog.json').read_bytes())
 checks=S.sums((root/'firmware/SHA256SUMS').read_bytes())
 for r in catalog['releases']+catalog.get('recoveryReleases',[]):
  for f in r['files']:
   need(checks.get(f['id'])==f['sha256'],'Local checksum manifest disagrees with signed catalog')
   base[f['url']]=S.sha((root/f['url']).read_bytes())
 # Include code dependencies, since these implement the checked transition.
 dependencies={str(HERE/n):S.sha((HERE/n).read_bytes())for n in('consume-phoenix.py','sync-phoenix.py','check-phoenix.mjs')}
 return catalog,base,dependencies,existing

def unchanged(root,base,dependencies):
 for name,h in base.items():
  p=root/name;need(not p.is_symlink()and p.is_file()and S.sha(p.read_bytes())==h,'Current catalog/key/firmware changed during preparation')
 for name,h in dependencies.items():need(S.sha(Path(name).read_bytes())==h,'Consumer validation code changed during preparation')

def phoenix_identity(entry):
 return {k:entry.get(k)for k in('id','project','device','version','files','parts','partitions','source','manual','upstream')}

def stage_signed(root,destination,catalog_bytes,signature,release,blobs,meta,base,dependencies):
 root=root.resolve();destination=destination.resolve()
 need(not destination.is_relative_to(root.parent),'Stage must be outside the website checkout')
 need(not destination.exists(),'Stage exists; refusing overwrite')
 destination.parent.mkdir(parents=True,exist_ok=True)
 lock=destination.with_name(destination.name+'.lock');fd=None
 try:
  fd=os.open(lock,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
  payload={'flasher/catalog.json':catalog_bytes,'flasher/catalog.sig':signature,'flasher/firmware/SHA256SUMS':S.local_sums((root/'firmware/SHA256SUMS').read_bytes(),release)}
  for f,name in zip(release['files'],(S.APP,S.ASSETS)):
   old=root/f['url'];need(not old.is_symlink(),'Versioned firmware path is a symlink')
   if old.exists():need(old.read_bytes()==blobs[name],'Immutable versioned firmware already differs')
   payload['flasher/'+f['url']]=blobs[name]
  with tempfile.TemporaryDirectory(prefix='.phoenix-consumer-',dir=destination.parent)as work:
   stage=Path(work)/'payload';stage.mkdir();rows=[]
   for name,data in payload.items():
    p=stage/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
    need(p.read_bytes()==data,'Stage write/readback mismatch')
    rows.append({'path':name,'bytes':len(data),'sha256':S.sha(data)})
   report={'status':'SIGNED_VERIFIED_STAGE_NOT_APPLIED','repository':REPO,'release':bundle_pin(meta),'catalogSHA256':S.sha(catalog_bytes),'signatureSHA256':S.sha(signature),'keyFingerprint':KEY_FINGERPRINT,'baseInputs':base,'validationDependencies':dependencies,'copyAllowlist':rows,'signatureIncluded':True,'consumerSigns':False,'checkoutModified':False,'deploymentPerformed':False}
   (stage/'PLAN.json').write_text(json.dumps(report,indent=2)+'\n')
   unchanged(root,base,dependencies)
   need(not destination.exists(),'Stage destination appeared during preparation')
   os.rename(stage,destination)
  return report
 finally:
  if fd is not None:
   os.close(fd);lock.unlink(missing_ok=True)

def consume(root,node,fetch_metadata,fetch_asset,stage=None,expected_tag=None):
 root=Path(root).resolve();need(node is not None,'Node22+ is required')
 current,base,dependencies,existing=current_state(root,node)
 meta=fetch_metadata('releases/latest');tag,_,_=S.release_metadata(meta)
 need(expected_tag is None or expected_tag==tag,'Latest stable tag differs from requested tag')
 _,old=S.active(current);need(S.version(tag,True)>=S.version(old['version']),'Refusing firmware downgrade')
 pinned=fetch_metadata('releases/tags/'+tag)
 initial=bundle_pin(meta);need(bundle_pin(pinned)==initial,'Latest/tag release identity differs')
 original,signed=metadata_assets(meta)
 if set(signed)!={CATALOG,SIGNATURE}:
  final_latest=fetch_metadata('releases/latest');final_tag=fetch_metadata('releases/tags/'+tag)
  need(bundle_pin(final_latest)==initial==bundle_pin(final_tag),'Release changed while checking signed bundle availability')
  unchanged(root,base,dependencies)
  return {'status':'WAITING_FOR_SIGNED_BUNDLE','repository':REPO,'tag':tag,'changed':False,'missing':[n for n in(CATALOG,SIGNATURE)if n not in signed],'checkoutModified':False,'deploymentPerformed':False}
 data={}
 for name in(CATALOG,SIGNATURE):
  a=signed[name];b=fetch_asset(a['browser_download_url'],a['size']);need(len(b)==a['size'],'Signed asset length mismatch')
  if a.get('digest'):need(a['digest']=='sha256:'+S.sha(b),'Signed asset digest mismatch')
  data[name]=b
 verify_signature(root,data[CATALOG],data[SIGNATURE]);incoming=strict_json(data[CATALOG])
 need(isinstance(incoming,dict)and type(incoming.get('format'))is int and incoming['format']==1,'Invalid signed catalog format')
 blobs={name:fetch_asset(a['browser_download_url'],a['size'])for name,a in original.items()}
 S.validate_downloads(meta,blobs)
 expected,release,changed=S.plan(current,meta,blobs);fresh=S.new_release(meta,blobs)
 if changed:
  need(semantic_equal(incoming,expected),'Signed catalog differs from the exact Phoenix-only transition')
  S.validate_transition(current,incoming,release)
 else:
  _,current_phoenix=S.active(current);_,signed_phoenix=S.active(incoming)
  need(semantic_equal(phoenix_identity(signed_phoenix),phoenix_identity(fresh)),'Signed same-version Phoenix identity differs from upstream')
  need(current_phoenix.get('upstream')==fresh['upstream'],'Current same-version Phoenix upstream identity is missing or changed')
  # Seeder or other global data may legitimately have advanced since signing.
  # A verified unchanged Phoenix release performs no catalog writes at all.
 with tempfile.TemporaryDirectory(prefix='phoenix-core-')as work:
  p=Path(work);(p/'release.json').write_text(json.dumps(fresh));(p/S.APP).write_bytes(blobs[S.APP]);(p/S.ASSETS).write_bytes(blobs[S.ASSETS])
  core=S.check_node(node,root,'incoming',p/'release.json',p/S.APP,p/S.ASSETS)
 latest_final=fetch_metadata('releases/latest');tag_final=fetch_metadata('releases/tags/'+tag)
 need(bundle_pin(latest_final)==initial==bundle_pin(tag_final),'Latest/tag assets changed during verification')
 unchanged(root,base,dependencies)
 result={'status':'SIGNED_UPDATE_AVAILABLE'if changed else'UP_TO_DATE','repository':REPO,'tag':tag,'changed':changed,'catalogSHA256':S.sha(data[CATALOG]),'signatureSHA256':S.sha(data[SIGNATURE]),'existing':existing,'incoming':core,'consumerSigns':False,'checkoutModified':False,'deploymentPerformed':False}
 if stage is not None and changed:result['stage']=stage_signed(root,Path(stage),data[CATALOG],data[SIGNATURE],release,blobs,meta,base,dependencies)
 return result

def main(argv=None):
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--flasher-root',type=Path,default=HERE.parent);p.add_argument('--node',default=shutil.which('node'));p.add_argument('--expected-tag');p.add_argument('--stage',type=Path);p.add_argument('--check',action='store_true')
 a=p.parse_args(argv)
 try:
  result=consume(a.flasher_root,a.node,gh_metadata,S.download,a.stage,a.expected_tag)
  print(json.dumps(result,indent=2));return 3 if a.check and result['changed']else 0
 except(S.Invalid,OSError,ValueError,KeyError,StopIteration,subprocess.TimeoutExpired)as e:
  print('Phoenix signed consumer stopped: '+str(e),file=sys.stderr);return 1
if __name__=='__main__':sys.exit(main())
