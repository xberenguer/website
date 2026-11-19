#!/usr/bin/env python3
"""Offline regression tests using checked-out ESP images and validator modules.
Synthetic next-release metadata and ephemeral signing keys stay in temporary
directories. No network, device or existing private-key access is required.
"""
import contextlib,copy,hashlib,importlib.util,json,os,shutil,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode=True
P=Path(__file__).resolve().parent
BASE=Path(os.environ.get('PHOENIX_TEST_BASE',str(P.parent))).resolve()
DRAFT=Path(os.environ.get('PHOENIX_TEST_SCRIPTS',str(BASE/'scripts'))).resolve()
NODE=os.environ.get('PHOENIX_TEST_NODE')or shutil.which('node')
if NODE is None:raise RuntimeError('Node22+ required inPATHorPHOENIX_TEST_NODE')
H=lambda b:hashlib.sha256(b).hexdigest()
def run(cmd):return subprocess.run(list(map(str,cmd)),capture_output=True,check=True).stdout
def tree(p):return {str(f.relative_to(p)):H(f.read_bytes())for f in p.rglob('*')if f.is_file()}
def canonical(d):return(json.dumps(d,indent=3,ensure_ascii=False)+'\n').encode()

class ConsumerTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.scratch=tempfile.TemporaryDirectory(prefix='phoenix165-tests-');cls.tmp=Path(cls.scratch.name)
  cls.key=cls.tmp/'ephemeral-private.pem';cls.pub=cls.tmp/'ephemeral-public.pem'
  run(['openssl','genpkey','-algorithm','ED25519','-out',cls.key]);run(['openssl','pkey','-in',cls.key,'-pubout','-out',cls.pub])
  raw=run(['openssl','pkey','-pubin','-in',cls.pub,'-outform','DER'])[-32:];cls.raw=raw.hex();cls.fp=H(raw)
  cls.codes=cls.tmp/'code';cls.codes.mkdir()
  for name in ['consume-phoenix.py','sync-phoenix.py','check-phoenix.mjs']:
   s=(DRAFT/name).read_text()
   if name=='consume-phoenix.py':
    s=s.replace("PUBLIC_KEY_HEX='044b1a970af958277f4a742b0f4544526406ac99e00575d25f5bbf0b17b28a7a'","PUBLIC_KEY_HEX='"+cls.raw+"'")
    s=s.replace("KEY_FINGERPRINT='34568ae48435426bb68028eb6f3bb338a2cba5115c906a33ca26c3592c31c5d4'","KEY_FINGERPRINT='"+cls.fp+"'")
    normal=s.replace("PUBLIC_KEY_HEX='"+cls.raw+"'","PUBLIC_KEY_HEX='044b1a970af958277f4a742b0f4544526406ac99e00575d25f5bbf0b17b28a7a'").replace("KEY_FINGERPRINT='"+cls.fp+"'","KEY_FINGERPRINT='34568ae48435426bb68028eb6f3bb338a2cba5115c906a33ca26c3592c31c5d4'")
    assert normal==(DRAFT/name).read_text()
   elif name=='check-phoenix.mjs':s=s.replace('34568ae48435426bb68028eb6f3bb338a2cba5115c906a33ca26c3592c31c5d4',cls.fp)
   (cls.codes/name).write_text(s)
  spec=importlib.util.spec_from_file_location('consumer165test',cls.codes/'consume-phoenix.py');cls.C=importlib.util.module_from_spec(spec);spec.loader.exec_module(cls.C)
  cls.base=cls.tmp/'base';cls.base.mkdir();shutil.copytree(BASE/'firmware',cls.base/'firmware');shutil.copytree(BASE/'vendor/noble',cls.base/'vendor/noble')
  for name in ['core.js','events.js','blackjack.js','flash-read.js','release-status.js','package.json','catalog.json']:shutil.copyfile(BASE/name,cls.base/name)
  s=(BASE/'signing.js').read_text().replace('044b1a970af958277f4a742b0f4544526406ac99e00575d25f5bbf0b17b28a7a',cls.raw).replace('34568ae48435426bb68028eb6f3bb338a2cba5115c906a33ca26c3592c31c5d4',cls.fp)
  (cls.base/'signing.js').write_text(s);shutil.copyfile(cls.pub,cls.base/'release-key.pem')
  cls.sign_file(cls.base/'catalog.json',cls.base/'catalog.sig')
  original_catalog=json.loads((BASE/'catalog.json').read_text());_,active=cls.C.S.active(original_catalog)
  current_version=cls.C.S.version(active['version']);cls.next_tag='v'+'.'.join(map(str,(*current_version[:2],current_version[2]+1)))
  source_files={f['id']:BASE/f['url']for f in active['files']}
  application=next(p for p in active['parts']if p['kind']=='application')['file'];assets=next(p for p in active['parts']if p['kind']=='assets')['file']
  cls.original={cls.C.S.APP:source_files[application].read_bytes(),cls.C.S.ASSETS:source_files[assets].read_bytes()}
  cls.original[cls.C.S.SUMS]=(''.join(H(b)+'  '+n+'\n'for n,b in cls.original.items())).encode()
  cls.original_meta={'draft':False,'prerelease':False,'id':107001,'tag_name':cls.next_tag,'html_url':cls.C.S.WEB+'/releases/tag/'+cls.next_tag,'published_at':'2026-11-15T19:00:00Z','assets':[{'name':n,'id':107010+i,'size':len(b),'digest':'sha256:'+H(b),'browser_download_url':cls.C.S.WEB+'/releases/download/'+cls.next_tag+'/'+n}for i,(n,b)in enumerate(cls.original.items())]}
  cls.source_pins={str(f):H(f.read_bytes())for f in [BASE/'core.js',BASE/'events.js',BASE/'blackjack.js',BASE/'flash-read.js',BASE/'release-status.js',BASE/'signing.js',BASE/'catalog.json',BASE/'catalog.sig',*source_files.values(),*DRAFT.glob('*'),*(BASE/'vendor/noble').glob('*.js')]if f.is_file()}
 @classmethod
 def sign_file(cls,source,dest):run(['openssl','pkeyutl','-sign','-inkey',cls.key,'-rawin','-in',source,'-out',dest])
 @classmethod
 def tearDownClass(cls):
  assert all(H(Path(f).read_bytes())==h for f,h in cls.source_pins.items())
  cls.scratch.cleanup()
 def setUp(self):
  self.work=tempfile.TemporaryDirectory(prefix='phoenix165-case-');self.w=Path(self.work.name);self.root=self.w/'checkout/flasher';shutil.copytree(self.base,self.root);self.stage=self.w/'out/stage';self.downloads=[];self.calls=[]
  self.blobs=copy.deepcopy(self.original);self.meta=copy.deepcopy(self.original_meta)
  self.current=self.C.strict_json((self.root/'catalog.json').read_bytes());self.expected,self.release,_=self.C.S.plan(self.current,self.meta,self.blobs)
  self.bundle(self.expected);self.before=tree(self.root)
 def tearDown(self):self.work.cleanup()
 def bundle(self,catalog,raw=None,sign=True):
  data=canonical(catalog)if raw is None else raw;src=self.w/'sign-input';sig=self.w/'signature';src.write_bytes(data)
  if sign:self.sign_file(src,sig)
  signature=sig.read_bytes()if sign else b'X'*64
  self.blobs[self.C.CATALOG]=data;self.blobs[self.C.SIGNATURE]=signature
  self.meta['assets']=[a for a in self.meta['assets']if a['name']not in(self.C.CATALOG,self.C.SIGNATURE)]
  for i,name in enumerate([self.C.CATALOG,self.C.SIGNATURE]):
   b=self.blobs[name];self.meta['assets'].append({'name':name,'id':107020+i,'size':len(b),'digest':'sha256:'+H(b),'browser_download_url':self.C.S.WEB+'/releases/download/'+self.meta['tag_name']+'/'+name})
 def fetch_meta(self,endpoint):self.calls.append(endpoint);return copy.deepcopy(self.meta)
 def fetch_asset(self,url,limit):
  self.assertTrue(url.startswith(self.C.S.WEB+'/releases/download/'));name=url.rsplit('/',1)[1];self.downloads.append(name);b=self.blobs[name];self.assertLessEqual(len(b),limit);return b
 def consume(self,meta=None,stage=True):return self.C.consume(self.root,NODE,meta or self.fetch_meta,self.fetch_asset,self.stage if stage else None)
 def reject(self,match=None,meta=None):
  with self.assertRaises((self.C.S.Invalid,OSError,ValueError))as e:self.consume(meta)
  if match:self.assertIn(match,str(e.exception))
  self.assertFalse(self.stage.exists());self.assertEqual(tree(self.root),self.before)
 def install_current_next(self):
  for f,name in zip(self.release['files'],(self.C.S.APP,self.C.S.ASSETS)):(self.root/f['url']).write_bytes(self.original[name])
  (self.root/'firmware/SHA256SUMS').write_bytes(self.C.S.local_sums((self.root/'firmware/SHA256SUMS').read_bytes(),self.release))
  (self.root/'catalog.json').write_bytes(canonical(self.expected));self.sign_file(self.root/'catalog.json',self.root/'catalog.sig')
 def test_01_signed_update_preserves_exact_bytes_and_all_other_state(self):
  result=self.consume();self.assertEqual(result['status'],'SIGNED_UPDATE_AVAILABLE');self.assertEqual((self.stage/'flasher/catalog.json').read_bytes(),self.blobs[self.C.CATALOG]);self.assertEqual((self.stage/'flasher/catalog.sig').read_bytes(),self.blobs[self.C.SIGNATURE]);self.assertEqual(tree(self.root),self.before)
  plan=json.loads((self.stage/'PLAN.json').read_text());self.assertEqual(len(plan['copyAllowlist']),5);self.assertFalse(plan['consumerSigns']);self.assertEqual(result['incoming']['parts'],5)
 def test_02_forged_signature_rejected_before_firmware_download(self):
  self.bundle(self.expected,sign=False);self.reject('signature does not match');self.assertNotIn(self.C.S.APP,self.downloads)
 def test_03_modified_catalog_with_old_signature(self):
  signature=self.blobs[self.C.SIGNATURE];self.bundle(self.expected,raw=self.blobs[self.C.CATALOG]+b' ');self.blobs[self.C.SIGNATURE]=signature
  for a in self.meta['assets']:
   if a['name']==self.C.SIGNATURE:a['digest']='sha256:'+H(signature)
  self.reject('signature does not match')
 def test_04_valid_signature_cannot_tamper_other_project(self):
  bad=copy.deepcopy(self.expected);bad['projects'][0]['summary']='changed Seeder';self.bundle(bad);self.reject('exact Phoenix-only transition')
 def test_05_valid_but_stale_seedercatalog_rejected_for_new_version(self):
  now=copy.deepcopy(self.current);now['releases'][0]['qualification']='legitimate later Seeder qualification';(self.root/'catalog.json').write_bytes(canonical(now));self.sign_file(self.root/'catalog.json',self.root/'catalog.sig');self.before=tree(self.root);self.reject('exact Phoenix-only transition')
 def test_06_recovery_entries_preserved_exactly(self):
  bad=copy.deepcopy(self.expected);bad['recoveryReleases'].pop(0);self.bundle(bad);self.reject('exact Phoenix-only transition')
 def test_07_same_version_newer_seeder_noop(self):
  self.install_current_next();now=copy.deepcopy(self.expected);now['projects'][0]['summary']='newer Seeder information';now['releases'][0]['qualification']='later Seeder qualification';(self.root/'catalog.json').write_bytes(canonical(now));self.sign_file(self.root/'catalog.json',self.root/'catalog.sig');self.before=tree(self.root)
  result=self.consume();self.assertEqual(result['status'],'UP_TO_DATE');self.assertFalse(result['changed']);self.assertFalse(self.stage.exists());self.assertEqual(tree(self.root),self.before)
 def test_08_same_version_signed_phoenix_identity_must_match(self):
  self.install_current_next();self.before=tree(self.root);bad=copy.deepcopy(self.expected);_,r=self.C.S.active(bad);r['upstream']['releaseId']+=1;self.bundle(bad);self.reject('same-version Phoenix identity')
 def test_09_downgrade_rejected_even_without_bundle(self):
  self.meta['tag_name']='v0.0.0';self.meta['html_url']=self.C.S.WEB+'/releases/tag/v0.0.0';self.meta['assets']=[a for a in self.meta['assets']if a['name']not in(self.C.CATALOG,self.C.SIGNATURE)]
  for a in self.meta['assets']:a['browser_download_url']=self.C.S.WEB+'/releases/download/v0.0.0/'+a['name']
  self.reject('downgrade');self.assertFalse(self.downloads)
 def test_10_latest_original_asset_race(self):
  def meta(endpoint):
   value=self.fetch_meta(endpoint)
   if len(self.calls)>=3:value['assets'][0]['id']+=1
   return value
  self.reject('changed during verification',meta)
 def test_11_signed_asset_identity_race(self):
  def meta(endpoint):
   value=self.fetch_meta(endpoint)
   if len(self.calls)>=3:value['assets'][-1]['id']+=1
   return value
  self.reject('changed during verification',meta)
 def test_12_missing_signed_bundle_waits_without_any_download(self):
  self.meta['assets']=[a for a in self.meta['assets']if a['name']not in(self.C.CATALOG,self.C.SIGNATURE)];r=self.consume();self.assertEqual(r['status'],'WAITING_FOR_SIGNED_BUNDLE');self.assertFalse(r['changed']);self.assertFalse(self.downloads);self.assertFalse(self.stage.exists());self.assertEqual(tree(self.root),self.before)
 def test_13_atomic_rename_failure_leaves_no_stage_or_checkout_write(self):
  with patch.object(self.C.os,'rename',side_effect=OSError('injected rename failure')):self.reject('injected rename failure')
  self.assertFalse(list((self.w/'out').glob('.phoenix-consumer-*')));self.assertFalse(self.stage.with_name(self.stage.name+'.lock').exists())
 def test_14_valid_signature_does_not_make_boolean_equal_integer(self):
  bad=copy.deepcopy(self.expected);bad['format']=True;self.bundle(bad);self.reject('catalog format')
 def test_15_signed_duplicate_json_field_rejected(self):
  b=self.blobs[self.C.CATALOG].replace(b'{',b'{"format":1,',1);self.bundle(self.expected,raw=b);self.reject('Duplicate JSON field')
 def test_16_wrong_signed_bundle_repository_rejected(self):
  self.meta['assets'][-1]['browser_download_url']='https://github.com/other/repo/releases/download/'+self.meta['tag_name']+'/'+self.C.SIGNATURE;self.reject('another repository/tag');self.assertFalse(self.downloads)
 def test_17_actual_core_rejects_selfconsistent_invalid_partition_table(self):
  bad=bytearray(self.original[self.C.S.APP]);bad[0x8000+12]^=1;self.blobs={self.C.S.APP:bytes(bad),self.C.S.ASSETS:self.original[self.C.S.ASSETS]};self.blobs[self.C.S.SUMS]=(''.join(H(b)+'  '+n+'\n'for n,b in self.blobs.items())).encode()
  self.meta=copy.deepcopy(self.original_meta)
  for a in self.meta['assets']:a['digest']='sha256:'+H(self.blobs[a['name']]);a['size']=len(self.blobs[a['name']])
  expected,_,_=self.C.S.plan(self.current,self.meta,self.blobs);self.bundle(expected);self.reject('Existing flasher contract failed')
 def test_18_current_binary_corruption_fails_before_metadata(self):
  r=self.current['releases'][0];f=self.root/r['files'][0]['url'];data=bytearray(f.read_bytes());data[-1]^=1;f.write_bytes(data);self.before=tree(self.root);self.reject('Existing flasher contract failed');self.assertFalse(self.calls)
 def test_19_gh_cli_uses_fixed_host_without_token_argv_or_error_leak(self):
  secret='test-secret-never-log';response=subprocess.CompletedProcess([],0,canonical(self.meta),b'')
  with patch.dict(os.environ,{'GH_TOKEN':secret}),patch.object(self.C.subprocess,'run',return_value=response)as mock:
   self.C.gh_metadata('releases/latest');argv=mock.call_args.args[0];self.assertNotIn(secret,str(argv));self.assertEqual(argv[:4],['gh','api','--hostname','github.com']);self.assertIn('repos/'+self.C.REPO+'/releases/latest',argv)
  with patch.dict(os.environ,{'GH_TOKEN':secret}),patch.object(self.C.subprocess,'run',return_value=subprocess.CompletedProcess([],1,b'',secret.encode())):
   with self.assertRaises(self.C.S.Invalid)as error:self.C.gh_metadata('releases/latest')
   self.assertNotIn(secret,str(error.exception))
 def test_20_same_version_original_asset_identity_change_rejected(self):
  self.install_current_next();self.before=tree(self.root);self.meta['assets'][0]['id']+=1;self.reject('Same version has changed upstream asset identity')
 def test_21_current_manifest_race_aborts_before_stage(self):
  def meta(endpoint):
   value=self.fetch_meta(endpoint)
   if len(self.calls)==3:
    f=self.root/'firmware/SHA256SUMS';f.write_bytes(f.read_bytes()+b'\n');self.before=tree(self.root)
   return value
  self.reject('changed during preparation',meta)
 def test_22_imported_core_dependency_race_aborts(self):
  def meta(endpoint):
   value=self.fetch_meta(endpoint)
   if len(self.calls)==3:
    f=self.root/'vendor/noble/utils.js';f.write_bytes(f.read_bytes()+b'\n');self.before=tree(self.root)
   return value
  self.reject('changed during preparation',meta)
 def test_23_partial_stage_write_failure_is_cleaned(self):
  original=Path.write_bytes
  def write(path,data):
   if path.name=='catalog.sig'and any(x.startswith('.phoenix-consumer-')for x in path.parts):raise OSError('injected stage write failure')
   return original(path,data)
  with patch.object(Path,'write_bytes',write):self.reject('injected stage write failure')
  self.assertFalse(list((self.w/'out').glob('.phoenix-consumer-*')));self.assertFalse(self.stage.with_name(self.stage.name+'.lock').exists())

if __name__=='__main__':
 suite=unittest.defaultTestLoader.loadTestsFromTestCase(ConsumerTests);result=unittest.TextTestRunner(verbosity=2).run(suite)
 record={'status':'PASS'if result.wasSuccessful()else'FAIL','tests':result.testsRun,'errors':len(result.errors),'failures':len(result.failures),'actualCoreAndESPImages':True,'syntheticFutureReleaseMetadata':True,'networkRequests':0,'ephemeralTestKeysOnly':True,'productionPrivateKeyAccess':False,'websiteWrites':False}
 if len(sys.argv)>1:Path(sys.argv[1]).write_text(json.dumps(record,indent=2)+'\n')
 print(json.dumps(record));sys.exit(0 if result.wasSuccessful()else 1)
