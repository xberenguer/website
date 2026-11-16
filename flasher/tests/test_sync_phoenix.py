"""Offline engineering fixtures; no signing keys, GitHub mutation or device I/O."""
from pathlib import Path
import copy,hashlib,importlib.util,json,os,struct,subprocess,tempfile,unittest,shutil,sys
F=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('sync_phoenix',F/'scripts/sync-phoenix.py');s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
BASE=json.loads((F/'catalog.json').read_text())
CURRENT=s.version(s.active(BASE)[1]['version'])
FUTURE='v%d.%d.%d'%(CURRENT[0],CURRENT[1],CURRENT[2]+10)
PRIOR_FUTURE='v%d.%d.%d'%(CURRENT[0],CURRENT[1],CURRENT[2]+9)
NODE=os.environ.get('PHOENIX_NODE')or shutil.which('node')
def esp(payload=bytes(range(256))):
 h=bytearray(24);h[0]=0xe9;h[1]=1;h[3]=0x3f;struct.pack_into('<H',h,12,9);h[23]=1
 b=h+struct.pack('<II',0x3fce0000,len(payload))+payload;c=0xef
 for x in payload:c^=x
 b+=bytes((-len(b)-1)%16);b+=bytes([c]);b+=hashlib.sha256(b).digest();return bytes(b)
def fixtures(tag=None,payload=None):
 tag=FUTURE if tag is None else tag
 app=esp()if payload is None else esp(payload);merged=bytearray([255])*(0x10000+len(app));merged[:len(esp())]=esp();merged[0x10000:]=app
 table=bytearray([255])*4096
 for i,r in enumerate(s.MAP):
  at=i*32;struct.pack_into('<HBBII16sI',table,at,0x50aa,r['type'],r['subtype'],r['offset'],r['size'],r['label'].encode(),r['flags'])
 at=32*len(s.MAP);struct.pack_into('<H',table,at,0xebeb);table[at+16:at+32]=hashlib.md5(table[:at]).digest();merged[0x8000:0x9000]=table
 blobs={s.APP:bytes(merged),s.ASSETS:bytes([165])*0x180000};blobs[s.SUMS]=''.join(s.sha(data)+'  '+name+'\n'for name,data in blobs.items()).encode()
 meta={'id':777,'tag_name':tag,'draft':False,'prerelease':False,'published_at':'2026-11-16T01:00:00Z','html_url':s.WEB+'/releases/tag/'+tag,'assets':[{'id':800+i,'name':name,'size':len(data),'digest':'sha256:'+s.sha(data),'browser_download_url':s.WEB+'/releases/download/'+tag+'/'+name}for i,(name,data)in enumerate(blobs.items())]};return meta,blobs
class SyncTests(unittest.TestCase):
 def setUp(self):self.meta,self.blobs=fixtures()
 def bad(self,change):
  m=copy.deepcopy(self.meta);change(m)
  with self.assertRaises(s.Invalid):s.plan(BASE,m,self.blobs)
 def test_good_geometry_archive_and_other_projects(self):
  out,r,changed=s.plan(BASE,self.meta,self.blobs);self.assertTrue(changed);self.assertEqual(r['parts'][3]['length'],len(self.blobs[s.APP])-0x10000);self.assertEqual(r['partitions'],s.MAP)
  old=s.active(BASE)[1];self.assertEqual(out['recoveryReleases'],BASE['recoveryReleases']+[old]);self.assertEqual([x for x in out['releases']if x['project']!='phoenix'],[x for x in BASE['releases']if x['project']!='phoenix'])
  for k in('projects','devices','otherProjects'):self.assertEqual(out[k],BASE[k])
 def test_prerelease_draft_and_missing_published(self):
  for key,value in(('prerelease',True),('draft',True),('published_at',None)):
   with self.subTest(key=key):self.bad(lambda m:m.update({key:value}))
 def test_wrong_repo_tag_or_non_numeric_tag(self):
  for change in(lambda m:m.update(html_url='https://github.com/other/project/releases/tag/v0.2.110'),lambda m:m.update(tag_name='v0.2.110-rc1'),lambda m:m['assets'][0].update(browser_download_url=s.WEB+'/releases/latest/download/'+s.APP)):
   self.bad(change)
 def test_duplicate_missing_and_oversized_assets(self):
  self.bad(lambda m:m['assets'].append(copy.deepcopy(m['assets'][0])));self.bad(lambda m:m['assets'].pop());self.bad(lambda m:m['assets'][0].update(size=0x800001))
 def test_wrong_hash_size_or_checksums(self):
  for change in(lambda b:b.update({s.APP:b[s.APP][:-1]}),lambda b:b.update({s.ASSETS:bytes(0x180000)}),lambda b:b.update({s.SUMS:b'0'*64+b'  '+s.APP.encode()+b'\n'})):
   b=dict(self.blobs);change(b)
   with self.assertRaises(s.Invalid):s.plan(BASE,self.meta,b)
 def test_noop_and_same_version_hash_change(self):
  updated,_,_=s.plan(BASE,self.meta,self.blobs);again,_,changed=s.plan(updated,self.meta,self.blobs);self.assertFalse(changed);self.assertEqual(updated,again)
  meta,b=fixtures(payload=bytes(reversed(range(256))))
  with self.assertRaisesRegex(s.Invalid,'Same version'):s.plan(updated,meta,b)
 def test_checksum_manifest_changes_do_not_create_catalog_cycle(self):
  updated,r,_=s.plan(BASE,self.meta,self.blobs);self.assertEqual(set(r['upstream']['assets']),{s.APP,s.ASSETS})
  m=copy.deepcopy(self.meta);b=dict(self.blobs);b[s.SUMS]+=b'1'*64+b'  flasher-catalog.json\n';a=next(x for x in m['assets']if x['name']==s.SUMS);a['size']=len(b[s.SUMS]);a['digest']='sha256:'+s.sha(b[s.SUMS]);a['id']+=10
  self.assertFalse(s.plan(updated,m,b)[2])
 def test_downgrade(self):
  updated,_,_=s.plan(BASE,self.meta,self.blobs);meta,b=fixtures(PRIOR_FUTURE)
  with self.assertRaisesRegex(s.Invalid,'downgrade'):s.plan(updated,meta,b)
 def test_s3_image_chip_flash_checksum_and_hash(self):
  for at in(12,3,24+8,303,304):
   b=bytearray(self.blobs[s.APP]);b[at]^=1
   with self.assertRaises(s.Invalid):s.image(b,0,0x8000)
 def test_erased_nvs_and_asset_size_required(self):
  for label in('nvs','assets'):
   m=copy.deepcopy(self.meta);b=dict(self.blobs)
   if label=='nvs':x=bytearray(b[s.APP]);x[0x9000]=0;b[s.APP]=bytes(x)
   else:b[s.ASSETS]=b[s.ASSETS][:-1]
   b[s.SUMS]=''.join(s.sha(b[n])+'  '+n+'\n'for n in(s.APP,s.ASSETS)).encode()
   for a in m['assets']:a['size']=len(b[a['name']]);a['digest']='sha256:'+s.sha(b[a['name']])
   with self.assertRaises(s.Invalid):s.plan(BASE,m,b)
 def test_duplicate_json_and_checksum_names(self):
  with self.assertRaises(s.Invalid):s.parse_json('{"a":1,"a":2}')
  with self.assertRaises(s.Invalid):s.sums(self.blobs[s.SUMS]+self.blobs[s.SUMS])
 def test_other_project_or_recovery_delta_rejected(self):
  out,r,_=s.plan(BASE,self.meta,self.blobs)
  for key in('projects','devices','otherProjects','recoveryReleases'):
   bad=copy.deepcopy(out);bad[key]=[]
   with self.assertRaises(s.Invalid):s.validate_transition(BASE,bad,r)
 def test_atomic_stage_no_signature_and_frozen_file_collision(self):
  out,r,_=s.plan(BASE,self.meta,self.blobs)
  with tempfile.TemporaryDirectory()as temp:
   root=Path(temp)/'site/flasher';shutil.copytree(F,root);base={n:s.sha((root/n).read_bytes())for n in('catalog.json','catalog.sig','release-key.pem','signing.js','core.js','firmware/SHA256SUMS')}
   dst=Path(temp)/'stage';report=s.write_stage(root,dst,out,r,self.blobs,self.meta,base);self.assertFalse(report['signatureIncluded']);self.assertFalse((dst/'flasher/catalog.sig').exists());self.assertEqual((root/'catalog.json').read_bytes(),(F/'catalog.json').read_bytes());self.assertEqual(set(report['copyAllowlist'][0]),{'path','bytes','sha256'})
   with self.assertRaises(s.Invalid):s.write_stage(root,dst,out,r,self.blobs,self.meta,base)
   with self.assertRaises(s.Invalid):s.write_stage(root,root/'bad-stage',out,r,self.blobs,self.meta,base)
   (root/r['files'][0]['url']).write_bytes(b'changed')
   with self.assertRaises(s.Invalid):s.write_stage(root,Path(temp)/'collision',out,r,self.blobs,self.meta,base)
 @unittest.skipUnless(NODE,'Node22+ required for actual flasher-core integration')
 def test_actual_core_and_offline_cli_check(self):
  with tempfile.TemporaryDirectory()as temp:
   p=Path(temp);(p/'metadata.json').write_text(json.dumps(self.meta))
   for name,b in self.blobs.items():(p/name).write_bytes(b)
   command=[sys.executable,'-B',str(F/'scripts/sync-phoenix.py'),'--flasher-root',str(F),'--node',NODE,'--fixture-dir',str(p),'--expected-tag',FUTURE,'--check'];r=subprocess.run(command,capture_output=True,text=True);self.assertEqual(r.returncode,3,r.stderr);data=json.loads(r.stdout);self.assertTrue(data['offlineFixture']);self.assertEqual(data['incoming']['parts'],5)
   r=subprocess.run(command[:-1]+['--dry-run'],capture_output=True,text=True);self.assertEqual(r.returncode,0,r.stderr)
   # A self-consistent SHA manifest must still fail the actual partition contract.
   bad=bytearray(self.blobs[s.APP]);bad[0x8000+28]=1;at=0x8000+32*len(s.MAP);bad[at+16:at+32]=hashlib.md5(bad[0x8000:at]).digest();blobs=dict(self.blobs);blobs[s.APP]=bytes(bad);blobs[s.SUMS]=''.join(s.sha(blobs[n])+'  '+n+'\n'for n in(s.APP,s.ASSETS)).encode();m=copy.deepcopy(self.meta)
   for a in m['assets']:a['size']=len(blobs[a['name']]);a['digest']='sha256:'+s.sha(blobs[a['name']])
   (p/'metadata.json').write_text(json.dumps(m))
   for n,b in blobs.items():(p/n).write_bytes(b)
   r=subprocess.run(command[:-1]+['--dry-run'],capture_output=True,text=True);self.assertEqual(r.returncode,1);self.assertIn('partition',r.stderr.lower())
if __name__=='__main__':
 import sys
 unittest.main(verbosity=2)
