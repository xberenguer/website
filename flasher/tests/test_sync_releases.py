"""Offline real-image release-sync regressions. No network or hardware access."""
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('sync_all_releases',ROOT/'scripts/sync-releases.py')
S=importlib.util.module_from_spec(spec);spec.loader.exec_module(S)
NODE=os.environ.get('SYNC_TEST_NODE') or shutil.which('node')
COMMIT='f'*40


def repair_image(data,start):
    at=start+24;check=0xef
    for _ in range(data[start+1]):
        size=struct.unpack_from('<I',data,at+4)[0];at+=8
        for x in data[at:at+size]:check^=x
        at+=size
    end=(at//16+1)*16;data[end-1]=check
    if data[start+23]:data[end:end+32]=hashlib.sha256(data[start:end]).digest()


def next_image(blob,old,new,start):
    assert len(old)==len(new) and old.encode() in blob
    out=bytearray(blob.replace(old.encode(),new.encode()))
    repair_image(out,start)
    return bytes(out)


class Provider:
    def __init__(self,catalog,config):
        self.meta={};self.data={};self.calls=[];self.mutate=None
        self.required_checks={c['repository']:c.get('requiredChecks',[]) for c in config['projects']}
        for c in config['projects']:
            project=c['project'];repo=c['repository'];old=[r for r in catalog['releases'] if r['project']==project]
            assets={}
            if project=='seeder':
                tag='v2.2.1-ports.1';rows=[]
                for r in old:
                    ver=r['version'].replace('2.2.0','2.2.1');f=r['files'][0]
                    b=(ROOT/f['url']).read_bytes();start=0 if r['device']=='waveshare175c' else 0x10000
                    b=next_image(b,r['version'],ver,start)
                    name=f['id'].replace(r['version'],ver)
                    files=[{'id':name,'url':name,'bytes':len(b),'sha256':S.sha(b)}]
                    rows.append({'device':r['device'],'version':ver,'files':files,
                                 'parts':S.fixed_parts(r['device'],files),'partitions':r['partitions']})
                    assets[name]=b
                assets['flasher-release.json']=S.encoded({'schemaVersion':1,'project':project,'repository':repo,'tag':tag,'commit':COMMIT,'releases':rows})
            elif project=='phoenix':
                r=old[0];n=list(S.version(r['version'])[:3]);n[-1]+=1;tag='v'+'.'.join(map(str,n))
                assets[S.P.APP]=(ROOT/r['files'][0]['url']).read_bytes()
                assets[S.P.ASSETS]=(ROOT/r['files'][1]['url']).read_bytes()
                assets[S.P.SUMS]=(''.join(S.sha(b)+'  '+name+'\n' for name,b in assets.items())).encode()
            elif project=='blackjack':
                ver='0.11.3'
                if old:
                    n=list(S.version(old[0]['version'])[:3]);n[-1]+=1;ver='.'.join(map(str,n))
                tag='v'+ver
                r=next(r for r in catalog['releases'] if r['project']=='stopwatch')
                app=bytearray((ROOT/r['files'][0]['url']).read_bytes());app[3]=(3<<4)|(app[3]&15)
                app[48:80]=ver.encode().ljust(32,b'\0');repair_image(app,0);app=bytes(app)
                sr=next(r for r in catalog['releases'] if r['project']=='seeder' and r['device']=='sticks3')
                source=(ROOT/sr['files'][0]['url']).read_bytes()
                merged=bytearray(b'\xff'*(0x10000+len(app)));merged[:0x8000]=source[:0x8000];merged[0xe000:0x10000]=source[0xe000:0x10000]
                table=bytearray(b'\xff'*4096)
                for i,p in enumerate(S.BJ.PARTITIONS):
                    struct.pack_into('<HBBII16sI',table,i*32,0x50aa,p['type'],p['subtype'],p['offset'],p['size'],p['label'].encode(),p['flags'])
                at=len(S.BJ.PARTITIONS)*32;struct.pack_into('<H',table,at,0xebeb);table[at+16:at+32]=hashlib.md5(table[:at]).digest()
                merged[0x8000:0x9000]=table;merged[0x10000:]=app
                names=['blackjack-sticks3-app.bin','blackjack-sticks3-install.bin'];assets=dict(zip(names,[app,bytes(merged)]))
                fs=[dict(id=n,url=n,bytes=len(assets[n]),sha256=S.sha(assets[n])) for n in names]
                rows=[dict(device='sticks3',version=ver,contract=S.BJ.CONTRACT,files=fs,parts=S.BJ.parts(*names,len(app)),partitions=S.BJ.PARTITIONS)]
                if S.version(ver)[:3]>=(0,12,0):
                    wave=bytearray((ROOT/r['files'][0]['url']).read_bytes());wave[48:80]=ver.encode().ljust(32,b'\0');repair_image(wave,0)
                    name='blackjack-waveshare175c-app.bin';assets[name]=bytes(wave)
                    rows.append(dict(device='waveshare175c',version=ver,contract=S.BJ.WAVESHARE_CONTRACT,
                      files=[dict(id=name,url=name,bytes=len(wave),sha256=S.sha(wave))],
                      parts=S.BJ.waveshare_parts(name,len(wave)),partitions=S.BJ.WAVESHARE_PARTITIONS))
                assets['flasher-release.json']=S.encoded(dict(schemaVersion=1,project=project,repository=repo,tag=tag,commit=COMMIT,releases=rows))
                assets['SHA256SUMS']=''.join(S.sha(b)+'  '+n+'\n' for n,b in assets.items()).encode()
            else:
                r=old[0];ver='1.1.2';tag='v'+ver
                b=(ROOT/r['files'][0]['url']).read_bytes();b=next_image(b,r['version'],ver,0)
                assets={'stopwatch-app.bin':b,'SHA256SUMS':(S.sha(b)+'  stopwatch-app.bin\n').encode()}
            meta={'id':100+len(self.meta),'draft':False,'prerelease':False,'published_at':'2026-11-17T10:00:00Z',
                  'tag_name':tag,'target_commitish':COMMIT,'html_url':'https://github.com/'+repo+'/releases/tag/'+tag,'assets':[]}
            for i,(name,b) in enumerate(assets.items()):
                url='https://github.com/'+repo+'/releases/download/'+tag+'/'+name
                meta['assets'].append({'id':1000+i,'name':name,'size':len(b),'digest':'sha256:'+S.sha(b),'browser_download_url':url})
                self.data[url]=b
            self.meta[repo]=meta

    def metadata(self,repo,endpoint):
        self.calls.append((repo,endpoint))
        if endpoint.startswith('git/ref/tags/'):
            result={'ref':'refs/tags/'+endpoint.removeprefix('git/ref/tags/'),'object':{'type':'commit','sha':COMMIT}}
        elif endpoint.startswith('commits/'):
            names=self.required_checks[repo]
            result={'total_count':len(names),'check_runs':[{'id':i+1,'name':name,'app':{'slug':'github-actions'},'head_sha':COMMIT,'status':'completed','conclusion':'success'} for i,name in enumerate(names)]}
        else:result=copy.deepcopy(self.meta[repo])
        if self.mutate:self.mutate(repo,endpoint,result)
        return result

    def download(self,url,limit):
        b=self.data[url];assert len(b)<=limit
        return b

    def change_manifest(self,fn):
        repo=S.REPOSITORIES['seeder'];meta=self.meta[repo]
        a=next(a for a in meta['assets'] if a['name']=='flasher-release.json')
        value=json.loads(self.data[a['browser_download_url']]);fn(value);b=S.encoded(value)
        self.data[a['browser_download_url']]=b;a.update(size=len(b),digest='sha256:'+S.sha(b))


class SyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if NODE is None:raise RuntimeError('Node22+ required')
        cls.catalog=json.loads((ROOT/'catalog.json').read_bytes())
        cls.config=json.loads((ROOT/'releases.config.json').read_bytes())

    def setUp(self):self.provider=Provider(self.catalog,self.config)
    def execute(self):return S.sync(ROOT,self.config,self.provider,NODE)
    def blocked(self,status,project):
        row=next(x for x in status['projects'] if x['project']==project)
        self.assertNotEqual(row['state'],'current');return row

    def test_all_projects_advance_and_archive_every_previous_contract(self):
        c,blobs,status=self.execute()
        self.assertTrue(all(s['state']=='current' for s in status['projects']))
        for old in self.catalog['releases']:
            self.assertIn(old,c['recoveryReleases'])
        self.assertEqual(len(c['releases']),len(self.catalog['releases'])+(0 if any(r['project']=='blackjack' for r in self.catalog['releases']) else 1))
        self.assertGreaterEqual(len(blobs),5)
        S.validate_files(ROOT,c,blobs,NODE)

    def test_incomplete_seeder_does_not_block_other_projects(self):
        self.provider.change_manifest(lambda m:m['releases'].pop())
        c,_,status=self.execute();row=self.blocked(status,'seeder')
        self.assertIn('every configured device',row['message'])
        self.assertEqual([r for r in c['releases'] if r['project']=='seeder'],[r for r in self.catalog['releases'] if r['project']=='seeder'])
        self.assertTrue(all(s['state']=='current' for s in status['projects'] if s['project']!='seeder'))

    def test_manifest_cannot_change_protected_partition_or_write_offset(self):
        for mutate in [lambda m:m['releases'][1]['parts'][0].update(address=0),
                       lambda m:m['releases'][0]['partitions'][0].update(offset=0)]:
            with self.subTest(mutate=mutate):
                self.provider=Provider(self.catalog,self.config);self.provider.change_manifest(mutate)
                _,_,status=self.execute();self.assertIn('approved device contract',self.blocked(status,'seeder')['message'])

    def test_manifest_wrong_source_commit_is_rejected(self):
        self.provider.change_manifest(lambda m:m.update(commit='a'*40))
        _,_,status=self.execute();self.assertIn('identity differs',self.blocked(status,'seeder')['message'])

    def test_failed_or_missing_automated_gate_is_blocked(self):
        for index,conclusion in [(0,'failure'),(1,'failure'),(2,None)]:
            def mutate(repo,endpoint,result):
                if endpoint.startswith('commits/'):result['check_runs'][index]['conclusion']=conclusion
            self.provider.mutate=mutate
            _,_,status=self.execute();self.assertIn('has not passed',self.blocked(status,'seeder')['message'])

    def test_drafts_and_prereleases_are_not_current(self):
        for field in ['draft','prerelease']:
            self.provider=Provider(self.catalog,self.config)
            self.provider.meta[S.REPOSITORIES['stopwatch']][field]=True
            _,_,status=self.execute();self.assertIn('stable releases',self.blocked(status,'stopwatch')['message'])

    def test_changed_downloaded_bytes_are_rejected(self):
        meta=self.provider.meta[S.REPOSITORIES['stopwatch']]
        a=next(a for a in meta['assets'] if a['name']=='stopwatch-app.bin');url=a['browser_download_url']
        b=bytearray(self.provider.data[url]);b[-1]^=1;self.provider.data[url]=bytes(b)
        _,_,status=self.execute();self.assertIn('digest mismatch',self.blocked(status,'stopwatch')['message'])

    def test_latest_race_and_source_tag_race_are_rejected(self):
        for target in ['latest','tag']:
            self.provider=Provider(self.catalog,self.config);counts={}
            def mutate(repo,endpoint,result):
                counts[(repo,endpoint)]=counts.get((repo,endpoint),0)+1
                if repo==S.REPOSITORIES['stopwatch']:
                    if target=='latest' and endpoint=='releases/latest' and counts[(repo,endpoint)]>1:result['id']+=1
                    if target=='tag' and endpoint.startswith('git/ref/') and counts[(repo,endpoint)]>1:result['object']['sha']='e'*40
            self.provider.mutate=mutate
            _,_,status=self.execute();self.blocked(status,'stopwatch')

    def test_asset_urls_and_duplicate_assets_are_rejected(self):
        for duplicate in [True,False]:
            self.provider=Provider(self.catalog,self.config);m=self.provider.meta[S.REPOSITORIES['stopwatch']]
            if duplicate:m['assets'].append(copy.deepcopy(m['assets'][0]))
            else:m['assets'][0]['browser_download_url']='https://evil.invalid/a.bin'
            _,_,status=self.execute();self.blocked(status,'stopwatch')

    def test_same_version_bytes_or_layout_cannot_change(self):
        old=self.catalog['releases'][0];new=copy.deepcopy(old)
        for mutate in [lambda r:r['files'][0].update(sha256='a'*64),lambda r:r['parts'][0].update(address=4096)]:
            r=copy.deepcopy(new);mutate(r)
            with self.assertRaisesRegex(S.Invalid,'Same version'):S.apply_entries(self.catalog,[r])

    def test_downgrade_does_not_replace_active_release(self):
        new=copy.deepcopy(self.catalog['releases'][0]);new['version']='1.0.0'
        with self.assertRaisesRegex(S.Invalid,'downgrade'):S.apply_entries(self.catalog,[new])

    def test_missing_release_retains_old_without_silent_success(self):
        old=self.provider.metadata
        def metadata(repo,endpoint):
            if repo==S.REPOSITORIES['stopwatch']:raise S.Invalid('GitHub metadata unavailable (HTTP 404)')
            return old(repo,endpoint)
        self.provider.metadata=metadata
        c,_,status=self.execute();self.blocked(status,'stopwatch')
        self.assertEqual(next(r for r in c['releases'] if r['project']=='stopwatch'),next(r for r in self.catalog['releases'] if r['project']=='stopwatch'))

    def test_noop_stage_creates_atomic_envelope_without_signing_key(self):
        with tempfile.TemporaryDirectory() as td:
            dest=Path(td)/'stage'
            report=S.stage(ROOT,dest,self.catalog,{}, {'checkedAt':'test','projects':[]},None)
            self.assertFalse(report['changed'])
            envelope=json.loads((dest/'flasher/catalog.signed.json').read_bytes())
            raw=base64.b64decode(envelope['catalog']);sig=base64.b64decode(envelope['signature'])
            self.assertEqual(raw,(ROOT/'catalog.json').read_bytes());S.signature(ROOT,raw,sig)
            self.assertFalse(any('private' in row['path'] for row in report['files']))
            with self.assertRaises(S.Invalid):S.stage(ROOT,dest,self.catalog,{}, {'projects':[]},None)

    def test_updated_catalog_cannot_stage_without_valid_signing_key(self):
        c=copy.deepcopy(self.catalog);c['projects'][0]['summary']='fixture'
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaisesRegex(S.Invalid,'signing key'):S.stage(ROOT,Path(td)/'stage',c,{}, {'projects':[]},None)
            key=Path(td)/'wrong.pem'
            subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',key],check=True,capture_output=True)
            os.environ['FLASHER_WRONG_TEST_KEY']=key.read_text()
            try:
                with self.assertRaisesRegex(S.Invalid,'differs'):S.stage(ROOT,Path(td)/'stage',c,{}, {'projects':[]},'FLASHER_WRONG_TEST_KEY')
            finally:del os.environ['FLASHER_WRONG_TEST_KEY']

    def test_supplied_wrong_key_is_rejected_even_when_catalog_is_unchanged(self):
        with tempfile.TemporaryDirectory() as td:
            key=Path(td)/'wrong.pem'
            subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',key],check=True,capture_output=True)
            os.environ['FLASHER_WRONG_TEST_KEY']=key.read_text()
            try:
                with self.assertRaisesRegex(S.Invalid,'differs'):
                    S.stage(ROOT,Path(td)/'stage',self.catalog,{}, {'projects':[]},'FLASHER_WRONG_TEST_KEY')
                self.assertFalse((Path(td)/'stage').exists())
            finally:del os.environ['FLASHER_WRONG_TEST_KEY']

    def test_ci_signing_emits_verifiable_envelope_and_never_exports_private_key(self):
        with tempfile.TemporaryDirectory() as td:
            base=Path(td);root=base/'site/flasher';root.mkdir(parents=True);(root/'firmware').mkdir()
            key=base/'ephemeral.pem'
            subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',key],check=True,capture_output=True)
            public=S.openssl('pkey','-in',key,'-pubout')
            (root/'release-key.pem').write_bytes(public)
            der=S.openssl('pkey','-pubin','-in',root/'release-key.pem','-outform','DER')
            raw=(ROOT/'catalog.json').read_bytes();(root/'catalog.json').write_bytes(raw)
            (root/'firmware/SHA256SUMS').write_bytes((ROOT/'firmware/SHA256SUMS').read_bytes())
            pem=key.read_text();os.environ['FLASHER_EPHEMERAL_TEST_KEY']=pem
            try:
                with patch.object(S,'TRUSTED_FINGERPRINT',S.sha(der[-32:])):
                    (root/'catalog.sig').write_bytes(S.signature(root,raw,pem=pem))
                    c=copy.deepcopy(self.catalog);c['projects'][0]['summary']='Changed fixture caption'
                    report=S.stage(root,base/'stage',c,{}, {'projects':[]},'FLASHER_EPHEMERAL_TEST_KEY')
                    self.assertTrue(report['changed'])
                    env=json.loads((base/'stage/flasher/catalog.signed.json').read_bytes())
                    S.signature(root,base64.b64decode(env['catalog']),base64.b64decode(env['signature']))
                    for f in (base/'stage').rglob('*'):
                        if f.is_file():self.assertNotIn(b'PRIVATE KEY',f.read_bytes())
            finally:del os.environ['FLASHER_EPHEMERAL_TEST_KEY']




class BlackjackAdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog=json.loads((ROOT/'catalog.json').read_bytes())
        # Explicit bootstrap tests use a catalog without any real Blackjack slot.
        cls.catalog['projects']=[p for p in cls.catalog['projects'] if p['id']!='blackjack']
        for key in ('releases','recoveryReleases'):
            cls.catalog[key]=[r for r in cls.catalog.get(key,[]) if r['project']!='blackjack']
        cls.config=json.loads((ROOT/'releases.config.json').read_bytes())
        cls.c=next(c for c in cls.config['projects'] if c['project']=='blackjack')

    def setUp(self):
        self.provider=Provider(self.catalog,self.config)
        self.meta=self.provider.meta[S.REPOSITORIES['blackjack']]

    def adapt(self):
        return S.BJ.releases(S,self.c,self.meta,COMMIT,self.provider)

    def alter(self, fn):
        # Rewrite internally consistent release metadata/checksums, so tests reach
        # the independent image/layout checks rather than just a digest mismatch.
        data={a['name']:self.provider.data[a['browser_download_url']] for a in self.meta['assets']}
        manifest=json.loads(data['flasher-release.json'])
        fn(manifest,data)
        for f in manifest['releases'][0]['files']:
            f.update(bytes=len(data[f['id']]),sha256=S.sha(data[f['id']]))
        data['flasher-release.json']=S.encoded(manifest)
        data['SHA256SUMS']=''.join(S.sha(b)+'  '+n+'\n' for n,b in data.items() if n!='SHA256SUMS').encode()
        for a in self.meta['assets']:
            b=data[a['name']];self.provider.data[a['browser_download_url']]=b;a.update(size=len(b),digest='sha256:'+S.sha(b))

    def test_bootstrap_preview_and_immutable_local_names(self):
        entries,blobs=self.adapt();r=entries[0]
        self.assertEqual(r['status'],'Preview')
        self.assertEqual(r['contract'],S.BJ.CONTRACT)
        self.assertEqual(len(blobs),2)
        self.assertEqual(r['files'][0]['id'],'blackjack-sticks3-0.11.3-app.bin')
        c=S.apply_entries(self.catalog,entries)
        self.assertEqual(next(p for p in c['projects'] if p['id']=='blackjack'),S.BJ.PROJECT)
        self.assertEqual(len(c['releases']),len(self.catalog['releases'])+1)
        self.assertEqual(S.apply_entries(c,entries),c)

    def test_existing_blackjack_uses_next_patch_and_archives_previous_contract(self):
        first,_=self.adapt();initial=S.apply_entries(self.catalog,first)
        provider=Provider(initial,self.config)
        meta=provider.meta[S.REPOSITORIES['blackjack']]
        entries,_=S.BJ.releases(S,self.c,meta,COMMIT,provider)
        self.assertEqual(entries[0]['version'],'0.11.4')
        updated=S.apply_entries(initial,entries)
        self.assertEqual(len(updated['releases']),len(initial['releases']))
        self.assertIn(first[0],updated['recoveryReleases'])
        self.assertEqual(sum(p['id']=='blackjack' for p in updated['projects']),1)

    def test_binary_alias_and_unqualified_boot_are_rejected(self):
        for mutation,message in [
          (lambda m,d:d.__setitem__('blackjack-sticks3-install.bin',d['blackjack-sticks3-install.bin'][:-1]+b'X'),'payloads differ'),
          (lambda m,d:d.__setitem__('blackjack-sticks3-install.bin',b'X'+d['blackjack-sticks3-install.bin'][1:]),'ESP32-S3'),
          (lambda m,d:m['releases'][0]['parts'][0].update(length=4096),'flash layout'),
          (lambda m,d:m['releases'][0]['partitions'][-1].update(subtype=2),'flash layout'),
          (lambda m,d:m.update(commit='0'*40),'identity differs')]:
            with self.subTest(message=message):
                self.setUp();self.alter(mutation)
                with self.assertRaisesRegex(S.Invalid,message):self.adapt()

    def test_other_valid_bootloader_and_boot_padding_are_rejected(self):
        def mutation(m,d):
            b=bytearray(d['blackjack-sticks3-install.bin']);b[2]^=1;repair_image(b,0)
            d['blackjack-sticks3-install.bin']=bytes(b)
        self.alter(mutation)
        with self.assertRaisesRegex(S.Invalid,'qualified public build'):self.adapt()
        self.setUp()
        def padding(m,d):
            b=bytearray(d['blackjack-sticks3-install.bin']);b[0x5000]=0
            d['blackjack-sticks3-install.bin']=bytes(b)
        self.alter(padding)
        with self.assertRaisesRegex(S.Invalid,'qualified public build'):self.adapt()

    def test_nvs_data_ota_bytes_and_checksums_are_rejected(self):
        for offset,message in [(0x9000,'NVS gap'),(0xe000,'OTA bytes')]:
            self.setUp()
            def mutation(m,d):
                b=bytearray(d['blackjack-sticks3-install.bin']);b[offset]^=1;d['blackjack-sticks3-install.bin']=bytes(b)
            self.alter(mutation)
            with self.assertRaisesRegex(S.Invalid,message):self.adapt()
        self.setUp()
        a=next(a for a in self.meta['assets'] if a['name']=='SHA256SUMS')
        b=b'0'*64+b'  blackjack-sticks3-app.bin\n';a.update(size=len(b),digest='sha256:'+S.sha(b));self.provider.data[a['browser_download_url']]=b
        with self.assertRaisesRegex(S.Invalid,'release checksums'):self.adapt()

    def test_missing_native_gate_does_not_bootstrap_project(self):
        original=self.provider.metadata
        def metadata(repo,endpoint):
            result=original(repo,endpoint)
            if repo==S.REPOSITORIES['blackjack'] and endpoint.startswith('commits/'):
                result['check_runs']=[]
            return result
        self.provider.metadata=metadata
        c,_,status=S.sync(ROOT,self.config,self.provider,NODE)
        row=next(r for r in status['projects'] if r['project']=='blackjack')
        self.assertEqual(row['state'],'blocked');self.assertIn('native',row['message'])
        existing=json.loads((ROOT/'catalog.json').read_bytes())
        self.assertEqual([r for r in c['releases'] if r['project']=='blackjack'],[r for r in existing['releases'] if r['project']=='blackjack'])
        self.assertEqual([p for p in c['projects'] if p['id']=='blackjack'],[p for p in existing['projects'] if p['id']=='blackjack'])


class BlackjackRoundAdapterTests(unittest.TestCase):
    setUpClass = classmethod(BlackjackAdapterTests.setUpClass.__func__)
    setUp = BlackjackAdapterTests.setUp
    adapt = BlackjackAdapterTests.adapt
    # Keep legacy one-device tests above unchanged; this fixture upgrades the
    # same source-bound release to the complete two-device0.12.0 contract.
    def round_fixture(self):
        data={a['name']:self.provider.data[a['browser_download_url']] for a in self.meta['assets']}
        m=json.loads(data['flasher-release.json']);old=m['releases'][0]['version'];ver='0.12.0'
        app=bytearray(data['blackjack-sticks3-app.bin']);app[48:80]=ver.encode().ljust(32,b'\0');repair_image(app,0)
        data['blackjack-sticks3-app.bin']=bytes(app)
        merged=bytearray(data['blackjack-sticks3-install.bin']);merged[0x10000:]=app;data['blackjack-sticks3-install.bin']=bytes(merged)
        r=next(r for r in self.catalog['releases'] if r['project']=='stopwatch')
        wave=bytearray((ROOT/r['files'][0]['url']).read_bytes());wave[48:80]=ver.encode().ljust(32,b'\0');repair_image(wave,0)
        name='blackjack-waveshare175c-app.bin';data[name]=bytes(wave)
        m['tag']='v'+ver;m['releases'][0]['version']=ver
        m['releases'].append(dict(device='waveshare175c',version=ver,contract=S.BJ.WAVESHARE_CONTRACT,
          files=[dict(id=name,url=name,bytes=len(wave),sha256=S.sha(wave))],
          parts=S.BJ.waveshare_parts(name,len(wave)),partitions=copy.deepcopy(S.BJ.WAVESHARE_PARTITIONS)))
        self.meta['tag_name']='v'+ver;self.meta['html_url']='https://github.com/'+S.REPOSITORIES['blackjack']+'/releases/tag/v'+ver
        self.write_round(m,data)

    def write_round(self,m,data):
        for row in m['releases']:
            for f in row['files']:
                if f['id'] in data:f.update(bytes=len(data[f['id']]),sha256=S.sha(data[f['id']]))
        data['flasher-release.json']=S.encoded(m)
        data['SHA256SUMS']=''.join(S.sha(b)+'  '+n+'\n' for n,b in data.items() if n!='SHA256SUMS').encode()
        self.meta['assets']=[]
        for i,(name,b) in enumerate(data.items()):
            url='https://github.com/'+S.REPOSITORIES['blackjack']+'/releases/download/'+self.meta['tag_name']+'/'+name
            self.meta['assets'].append(dict(id=3000+i,name=name,size=len(b),digest='sha256:'+S.sha(b),browser_download_url=url));self.provider.data[url]=b

    def mutate_round(self,fn):
        data={a['name']:self.provider.data[a['browser_download_url']]for a in self.meta['assets']}
        m=json.loads(data['flasher-release.json']);fn(m,data);self.write_round(m,data)

    def test_complete_round_release_bootstraps_both_targets_atomically(self):
        self.round_fixture();entries,blobs=self.adapt()
        self.assertEqual([e['device']for e in entries],['sticks3','waveshare175c']);self.assertEqual(len(blobs),3)
        wave=entries[1];self.assertEqual(wave['contract'],S.BJ.WAVESHARE_CONTRACT)
        self.assertEqual(wave['parts'],S.BJ.waveshare_parts(wave['files'][0]['id'],wave['files'][0]['bytes']))
        self.assertEqual(wave['partitions'],S.BJ.WAVESHARE_PARTITIONS)
        c=S.apply_entries(self.catalog,entries);self.assertEqual(sum(p['id']=='blackjack'for p in c['projects']),1)
        self.assertEqual(len([r for r in c['releases']if r['project']=='blackjack']),2)
        # Bootstrap fixtures deliberately remove Blackjack from the catalog.
        # Validate against that same isolated filesystem, not real release files
        # the sync workflow has just staged under these immutable names.
        with tempfile.TemporaryDirectory(prefix='blackjack-bootstrap-fixture-') as td:
            root=Path(td)
            (root/'package.json').write_text('{"type":"module"}')
            for source in ROOT.glob('*.js'):
                shutil.copy2(source,root/source.name)
            shutil.copytree(ROOT/'vendor',root/'vendor')
            for row in self.catalog['releases']+self.catalog.get('recoveryReleases',[]):
                for f in row['files']:
                    target=root/f['url'];target.parent.mkdir(parents=True,exist_ok=True)
                    shutil.copy2(ROOT/f['url'],target)
            S.validate_files(root,c,blobs,NODE)
            # Isolation must never weaken production filename immutability.
            target=root/entries[0]['files'][0]['url']
            target.write_bytes(b'conflicting staged image')
            with self.assertRaisesRegex(S.Invalid,'Immutable firmware filename'):
                S.validate_files(root,c,blobs,NODE)
        self.assertEqual(S.apply_entries(c,entries),c)

    def test_round_target_addition_preserves_existing_stick_contract(self):
        first,_=self.adapt();existing=S.apply_entries(self.catalog,first)
        self.round_fixture();entries,_=self.adapt();c=S.apply_entries(existing,entries)
        self.assertIn(first[0],c['recoveryReleases'])
        self.assertEqual([r['version']for r in c['releases']if r['project']=='blackjack'],['0.12.0','0.12.0'])
        with self.assertRaisesRegex(S.Invalid,'matching Stick'):
            S.apply_entries(existing,[entries[1]])

    def test_future_round_updates_keep_both_offerings_and_archive_both_previous_contracts(self):
        self.round_fixture();first,_=self.adapt();current=S.apply_entries(self.catalog,first)
        provider=Provider(current,self.config);meta=provider.meta[S.REPOSITORIES['blackjack']]
        entries,_=S.BJ.releases(S,self.c,meta,COMMIT,provider)
        self.assertEqual([r['version'] for r in entries],['0.12.1','0.12.1'])
        updated=S.apply_entries(current,entries)
        self.assertEqual(len(updated['releases']),len(current['releases']))
        self.assertTrue(all(r in updated['recoveryReleases'] for r in first))

    def test_new_round_version_requires_both_devices_in_canonical_order(self):
        for change in [lambda m,d:m['releases'].pop(),lambda m,d:m['releases'].reverse(),lambda m,d:m['releases'].append(m['releases'][1])]:
            self.setUp();self.round_fixture();self.mutate_round(change)
            with self.assertRaisesRegex(S.Invalid,'complete ordered device set'):self.adapt()

    def test_round_refuses_private_tail_or_factory_data_payloads(self):
        mutations=[
          lambda m,d:m['releases'][1]['parts'][0].update(address=0x770000),
          lambda m,d:m['releases'][1]['parts'].append(dict(file='blackjack-waveshare175c-app.bin',sourceOffset=0,length=4096,address=0x7f0000,kind='application')),
          lambda m,d:m['releases'][1]['partitions'][1].update(size=4096),
          lambda m,d:d.__setitem__('blackjack-waveshare175c-app.bin',d['blackjack-waveshare175c-app.bin']+b'X'*(S.BJ.WAVESHARE_MAX_APP+1))]
        for change in mutations:
            self.setUp();self.round_fixture();self.mutate_round(change)
            with self.assertRaises(S.Invalid):self.adapt()

    def test_round_wrong_capacity_or_embedded_version_is_rejected(self):
        for kind in ['capacity','version']:
            self.setUp();self.round_fixture()
            def change(m,d):
                b=bytearray(d['blackjack-waveshare175c-app.bin'])
                if kind=='capacity':b[3]=3<<4
                else:b[48:80]=b'0.11.3'.ljust(32,b'\0')
                repair_image(b,0);d['blackjack-waveshare175c-app.bin']=bytes(b)
            self.mutate_round(change)
            with self.assertRaises(S.Invalid):self.adapt()


if __name__ == '__main__': unittest.main()
