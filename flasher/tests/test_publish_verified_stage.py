#!/usr/bin/env python3
"""Fake REST and real local Git/core tests; never calls gh or the network.
Uses the existing consumer's ephemeral test-key fixture, never a production key.
"""
import base64,copy,importlib.util,json,os,shutil,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.dont_write_bytecode=True
import test_consume_phoenix as F
HERE=Path(__file__).resolve().parent
SCRIPT=Path(os.environ.get('PHOENIX_PUBLISHER_SCRIPT',str(HERE.parent/'scripts/publish-verified-stage.py')))
spec=importlib.util.spec_from_file_location('publisher168',SCRIPT);P=importlib.util.module_from_spec(spec);spec.loader.exec_module(P)
class FakeAPI:
 def __init__(self,local):self.local=local;self.main=local['base'];self.calls=[];self.gets=0;self.race=None;self.blob_bad=False;self.tree_bad=False;self.commit_bad=False;self.forbidden=False;self.timeout=False;self.new='c'*40
 def request(self,method,path,data=None):
  self.calls.append((method,path,copy.deepcopy(data)))
  if method=='GET'and path==P.API+'/git/ref/heads/main':
   self.gets+=1
   if self.race=='before-patch'and self.gets==2:self.main='d'*40
   return {'ref':'refs/heads/main','object':{'type':'commit','sha':self.main}}
  if method=='GET':return {'sha':self.local['base'],'tree':{'sha':self.local['base_tree']}}
  if self.forbidden:raise P.ApiError(method,path,403)
  if path.endswith('/blobs'):
   self.assert_blob=base64.b64decode(data['content']);return {'sha':'f'*40 if self.blob_bad else P.git_blob(self.assert_blob)}
  if path.endswith('/trees'):return {'sha':'f'*40 if self.tree_bad else self.local['tree']}
  if path.endswith('/commits'):return {'sha':self.new,'tree':{'sha':self.local['tree']},'parents':[{'sha':'f'*40 if self.commit_bad else self.local['base']}]}
  if method=='PATCH':
   if self.race=='inside-patch':self.main='d'*40
   if self.main!=self.local['base']:raise P.ApiError(method,path,422)
   self.main=self.new
   if self.timeout:raise P.ApiError(method,path)
   return {'ref':'refs/heads/main','object':{'type':'commit','sha':self.new}}
  raise AssertionError((method,path))
class PublisherTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  F.ConsumerTests.setUpClass();cls.fixture=F.ConsumerTests;cls.temp=tempfile.TemporaryDirectory(prefix='publisher168-tests-');cls.work=Path(cls.temp.name).resolve();cls.root=cls.work/'checkout';cls.root.mkdir();shutil.copytree(cls.fixture.base,cls.root/'flasher')
  scripts=cls.root/'flasher/scripts';scripts.mkdir()
  for p in cls.fixture.codes.iterdir():shutil.copyfile(p,scripts/p.name)
  shutil.copyfile(SCRIPT,scripts/'publish-verified-stage.py');(cls.root/'other-project.txt').write_text('Preserved unrelated project\n')
  def git(*a):return F.run(['git','-C',cls.root,*a])
  git('init','--initial-branch=main');git('add','.');git('-c','user.name=Publisher fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-m','Public test fixture')
  cls.C=P.consumer(cls.root);cls.stage=cls.work/'stage';current,base,deps,_=cls.C.current_state(cls.root/'flasher',F.NODE);meta=copy.deepcopy(cls.fixture.original_meta);blobs=cls.fixture.original
  expected,release,_=cls.C.S.plan(current,meta,blobs);raw=(json.dumps(expected,indent=2)+'\n').encode();source=cls.work/'sign-input';sig=cls.work/'signature';source.write_bytes(raw);cls.fixture.sign_file(source,sig)
  cls.C.stage_signed(cls.root/'flasher',cls.stage,raw,sig.read_bytes(),release,blobs,meta,base,deps)
  for row in json.loads((cls.stage/'PLAN.json').read_text())['copyAllowlist']:
   dst=cls.root/row['path'];dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(cls.stage/row['path'],dst)
  cls.local=P.validate_local(cls.root,cls.stage,F.NODE)
 @classmethod
 def tearDownClass(cls):cls.temp.cleanup();F.ConsumerTests.tearDownClass()
 def test_01_success_exact_five_file_commit_and_bot_identity(self):
  a=FakeAPI(self.local);r=P.publish(self.local,a);self.assertEqual(r['status'],'REF_UPDATE_ACKNOWLEDGED');self.assertEqual(a.main,a.new);self.assertEqual(len(r['paths']),5)
  blobs=[x for x in a.calls if x[1].endswith('/blobs')];self.assertEqual(len(blobs),5);self.assertEqual({P.git_blob(base64.b64decode(x[2]['content']))for x in blobs},{P.git_blob(b)for b in self.local['payload'].values()})
  tree=next(x[2]for x in a.calls if x[1].endswith('/trees'));self.assertEqual(tree['base_tree'],self.local['base_tree']);self.assertEqual({x['path']for x in tree['tree']},set(self.local['payload']));self.assertTrue(all(x['mode']=='100644'for x in tree['tree']))
  commit=next(x[2]for x in a.calls if x[1].endswith('/commits'));self.assertEqual(commit['parents'],[self.local['base']]);self.assertEqual(commit['tree'],self.local['tree']);self.assertEqual(commit['author']['email'],P.BOT['email']);self.assertEqual(commit['committer']['name'],P.BOT['name']);self.assertEqual(a.calls[-1][2],{'sha':a.new,'force':False})
 def test_02_stale_head_writes_nothing(self):
  a=FakeAPI(self.local);a.main='d'*40
  with self.assertRaises(P.Invalid):P.publish(self.local,a)
  self.assertTrue(all(x[0]=='GET'for x in a.calls));self.assertEqual(a.main,'d'*40)
 def test_03_changed_before_patch_stays_on_other_commit(self):
  a=FakeAPI(self.local);a.race='before-patch'
  with self.assertRaises(P.Invalid):P.publish(self.local,a)
  self.assertFalse(any(x[0]=='PATCH'for x in a.calls));self.assertEqual(a.main,'d'*40)
 def test_04_concurrent_forward_update_at_patch_rejected(self):
  a=FakeAPI(self.local);a.race='inside-patch'
  with self.assertRaises(P.ApiError):P.publish(self.local,a)
  self.assertEqual(a.main,'d'*40);self.assertEqual(sum(x[0]=='PATCH'for x in a.calls),1)
 def test_05_blob_mismatch_stops_before_tree(self):
  a=FakeAPI(self.local);a.blob_bad=True
  with self.assertRaises(P.Invalid):P.publish(self.local,a)
  self.assertFalse(any(x[1].endswith('/trees')for x in a.calls));self.assertEqual(a.main,self.local['base'])
 def test_06_tree_or_parent_mismatch_never_moves_ref(self):
  for name in('tree_bad','commit_bad'):
   a=FakeAPI(self.local);setattr(a,name,True)
   with self.assertRaises(P.Invalid):P.publish(self.local,a)
   self.assertFalse(any(x[0]=='PATCH'for x in a.calls));self.assertEqual(a.main,self.local['base'])
 def test_07_rest_403_is_failure_not_fixed(self):
  a=FakeAPI(self.local);a.forbidden=True
  with self.assertRaises(P.ApiError)as e:P.publish(self.local,a)
  self.assertEqual(e.exception.status,403);self.assertEqual(a.main,self.local['base'])
 def test_08_patch_timeout_is_uncertain_and_not_retried(self):
  a=FakeAPI(self.local);a.timeout=True
  with self.assertRaises(P.ApiError)as e:P.publish(self.local,a)
  self.assertIsNone(e.exception.status);self.assertEqual(sum(x[0]=='PATCH'for x in a.calls),1);self.assertEqual(a.main,a.new)
 def test_09_unexpected_dirty_file_rejected(self):
  p=self.root/'unexpected.txt';p.write_text('Never publish this\n')
  try:
   with self.assertRaises(P.Invalid):P.validate_local(self.root,self.stage,F.NODE)
  finally:p.unlink()
 def test_10_applied_or_stage_tamper_rejected(self):
  name='flasher/catalog.sig'
  for base in(self.root,self.stage):
   p=base/name;old=p.read_bytes();p.write_bytes(b'X'*64)
   try:
    with self.assertRaises(P.Invalid):P.validate_local(self.root,self.stage,F.NODE)
   finally:p.write_bytes(old)
 def test_11_invalid_signature_with_rehashed_plan_rejected(self):
  pp=self.stage/'PLAN.json';original=pp.read_bytes();signature=self.stage/'flasher/catalog.sig';old=signature.read_bytes();applied=self.root/'flasher/catalog.sig';signature.write_bytes(b'X'*64);applied.write_bytes(b'X'*64);plan=json.loads(original);plan['signatureSHA256']=P.sha(b'X'*64)
  for row in plan['copyAllowlist']:
   if row['path']=='flasher/catalog.sig':row['sha256']=plan['signatureSHA256']
  pp.write_text(json.dumps(plan))
  try:
   with self.assertRaises(ValueError):P.validate_local(self.root,self.stage,F.NODE)
  finally:signature.write_bytes(old);applied.write_bytes(old);pp.write_bytes(original)
 def test_12_exact_transition_blocks_protected_other_project(self):
  before=self.C.strict_json(P.git(self.root,'show','HEAD:flasher/catalog.json'));after=self.C.strict_json((self.stage/'flasher/catalog.json').read_bytes());_,new=self.C.S.active(after)
  for key in('devices','projects','otherProjects','recoveryReleases'):
   bad=copy.deepcopy(after);bad[key]=[]
   with self.assertRaises(ValueError):P.validate_catalog_change(self.C,before,bad,new)
 def test_13a_protected_json_types_are_not_equal(self):
  before=self.C.strict_json(P.git(self.root,'show','HEAD:flasher/catalog.json'));after=self.C.strict_json((self.stage/'flasher/catalog.json').read_bytes());_,new=self.C.S.active(after);after['format']=True
  with self.assertRaises(ValueError):P.validate_catalog_change(self.C,before,after,new)
 def test_13_extra_plan_path_rejected(self):
  p=self.stage/'PLAN.json';old=p.read_bytes();plan=json.loads(old);plan['copyAllowlist'].append({'path':'other-project.txt','bytes':1,'sha256':'0'*64});p.write_text(json.dumps(plan))
  try:
   with self.assertRaises(P.Invalid):P.validate_local(self.root,self.stage,F.NODE)
  finally:p.write_bytes(old)
 def test_14_tree_hash_matches_git_and_inherits_unrelated_files(self):
  entries=P.base_entries(self.root);self.assertEqual(P.tree_hash(entries),self.local['base_tree']);self.assertIn('other-project.txt',entries)
  modified=dict(entries)
  for name,b in self.local['payload'].items():modified[name]=('100644',P.git_blob(b))
  self.assertEqual(modified['other-project.txt'],entries['other-project.txt']);self.assertEqual(P.tree_hash(modified),self.local['tree'])
if __name__=='__main__':unittest.main(verbosity=2)
