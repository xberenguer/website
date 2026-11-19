#!/usr/bin/env python3
"""Stage bounded, verified stable GitHub releases for all configured projects.

--check never writes. --stage writes only a NEW external staging directory;
the caller applies and deploys it after running the installer regression tests.
The central signing key is supplied by environment, never by a release asset.
"""
import argparse
import base64
import copy
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import urllib.error
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('phoenix_image_contract', HERE/'sync-phoenix.py')
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
spec_bj = importlib.util.spec_from_file_location('blackjack_image_contract', HERE/'sync-blackjack.py')
BJ = importlib.util.module_from_spec(spec_bj)
spec_bj.loader.exec_module(BJ)
Invalid = P.Invalid
need = P.need
sha = P.sha
REPOSITORIES = {'seeder': 'xberenguer/Seeder-Fork', 'phoenix': P.REPO,
                'stopwatch': 'xberenguer/stopwatch', 'blackjack':'xberenguer/blackjack-trainer'}
TRUSTED_FINGERPRINT = '34568ae48435426bb68028eb6f3bb338a2cba5115c906a33ca26c3592c31c5d4'


def strict_json(data):
    def constant(_): raise Invalid('Non-finite JSON number')
    return json.loads(data, object_pairs_hook=P.nodup, parse_constant=constant)


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False)+'\n').encode()


def equal(a, b):
    return json.dumps(a, sort_keys=True, allow_nan=False) == json.dumps(b, sort_keys=True, allow_nan=False)


def version(value, device=None):
    m = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)(?:-(sticks3|ws175c)\.(\d+))?', value or '')
    need(m is not None, 'Unsupported stable device version')
    parts = m.groups()
    digits = [*parts[:3], parts[4] or '0']
    need(all(str(int(p)) == p for p in digits), 'Noncanonical device version')
    if parts[3]:
        need({'sticks3':'sticks3','waveshare175c':'ws175c'}.get(device) == parts[3], 'Version belongs to another device')
    return tuple(map(int, digits))


def release_metadata(meta, repo):
    need(isinstance(meta, dict) and meta.get('draft') is False and meta.get('prerelease') is False,
         'Only published stable releases are eligible')
    tag = meta.get('tag_name')
    need(isinstance(tag, str) and re.fullmatch(r'v\d+\.\d+\.\d+(?:-ports\.\d+)?', tag), 'Unsupported stable release tag')
    need(meta.get('html_url') == 'https://github.com/'+repo+'/releases/tag/'+tag,
         'Release belongs to another repository/tag')
    need(type(meta.get('id')) is int and meta['id'] > 0, 'Missing release identity')
    try:
        stamp = datetime.datetime.fromisoformat(meta['published_at'].replace('Z', '+00:00'))
        need(stamp.tzinfo is not None, 'Publication time lacks timezone')
    except (ValueError, KeyError, AttributeError): raise Invalid('Missing publication time')
    names, ids = set(), set()
    for a in meta.get('assets', []):
        name = a.get('name')
        need(isinstance(name, str) and re.fullmatch(r'[A-Za-z0-9._-]+', name), 'Unsafe asset name')
        need(name not in names and a.get('id') not in ids, 'Duplicate release asset')
        names.add(name); ids.add(a.get('id'))
        need(type(a.get('id')) is int and a['id'] > 0 and type(a.get('size')) is int and a['size'] > 0, 'Invalid asset ID/size')
        need(a.get('browser_download_url') == 'https://github.com/'+repo+'/releases/download/'+tag+'/'+name,
             'Asset URL is not pinned to the expected repository/tag')
        digest = a.get('digest')
        need(digest is None or re.fullmatch(r'sha256:[0-9a-f]{64}', digest), 'Invalid asset digest')
    return tag


def release_pin(meta):
    return {k:meta.get(k) for k in ('id','tag_name','published_at','target_commitish')} | {
        'assets':sorted([{k:a.get(k) for k in ('id','name','size','digest','browser_download_url')}
                         for a in meta.get('assets', [])], key=lambda a:a['name'])}


class GitHub:
    def metadata(self, repo, endpoint):
        need(repo in REPOSITORIES.values(), 'Unconfigured GitHub repository')
        need(re.fullmatch(r'(?:releases/latest|releases/tags/[A-Za-z0-9._-]+|git/ref/tags/[A-Za-z0-9._-]+|git/tags/[0-9a-f]{40}|commits/[0-9a-f]{40}/check-runs\?per_page=100)', endpoint), 'Unsafe GitHub endpoint')
        request = urllib.request.Request('https://api.github.com/repos/'+repo+'/'+endpoint,
            headers={'Accept':'application/vnd.github+json','User-Agent':'Firmware-Flasher-Sync/2',
                     'X-GitHub-Api-Version':'2022-11-28'})
        token = os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN')
        if token: request.add_header('Authorization','Bearer '+token)
        # API calls do not redirect. Tokens never accompany release-asset requests.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs): raise Invalid('GitHub API redirect rejected')
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
                data = response.read(1048577)
        except urllib.error.HTTPError as e:
            raise Invalid('GitHub metadata unavailable (HTTP '+str(e.code)+')') from None
        except OSError:
            raise Invalid('GitHub metadata request failed') from None
        need(len(data) <= 1048576, 'GitHub metadata exceeds limit')
        return strict_json(data)

    def download(self, url, limit):
        return P.download(url, limit)


def source_commit(provider, repo, tag):
    ref = provider.metadata(repo, 'git/ref/tags/'+tag)
    need(ref.get('ref') == 'refs/tags/'+tag, 'Tag ref identity differs')
    obj = ref.get('object', {})
    for _ in range(4):
        need(re.fullmatch(r'[0-9a-f]{40}', obj.get('sha','')), 'Invalid tag source commit')
        if obj.get('type') == 'commit': return obj['sha']
        need(obj.get('type') == 'tag', 'Tag does not resolve to a commit')
        value = provider.metadata(repo, 'git/tags/'+obj['sha'])
        need(value.get('sha') == obj['sha'], 'Annotated tag identity differs')
        obj = value.get('object', {})
    raise Invalid('Too many nested annotated tags')


def successful_checks(provider, repo, commit, required):
    if not required: return
    checks = provider.metadata(repo, 'commits/'+commit+'/check-runs?per_page=100')
    need(type(checks.get('total_count')) is int and checks['total_count'] <= 100,
         'Check-run set exceeds bounded validation; configure a release gate')
    for name in required:
        rows = [c for c in checks.get('check_runs',[]) if c.get('name') == name and c.get('app',{}).get('slug') == 'github-actions']
        need(bool(rows), 'Required automated check is missing: '+name)
        newest = max(rows, key=lambda c:c.get('id',0))
        need(newest.get('head_sha') == commit and newest.get('status') == 'completed'
             and newest.get('conclusion') == 'success', 'Required automated check has not passed: '+name)


def asset_bytes(provider, meta, name, limit):
    rows = [a for a in meta['assets'] if a['name'] == name]
    need(len(rows) == 1, 'Missing release asset: '+name)
    a = rows[0]
    need(a['size'] <= limit, 'Release asset exceeds device/metadata limit')
    data = provider.download(a['browser_download_url'], a['size'])
    need(len(data) == a['size'], 'Release asset size mismatch')
    if a.get('digest'): need(a['digest'] == 'sha256:'+sha(data), 'GitHub asset digest mismatch')
    return data, a


def image(data, start, limit, capacity):
    need(start+24 <= limit <= len(data), 'ESP image exceeds declared slice')
    need(data[start] == 0xe9 and 1 <= data[start+1] <= 16 and struct.unpack_from('<H',data,start+12)[0] == 9,
         'Firmware is not an ESP32-S3 image')
    need(data[start+3] >> 4 == {0x800000:3,0x2000000:5}[capacity], 'ESP image flash capacity differs')
    need(data[start+23] in (0,1), 'Invalid ESP image digest flag')
    at = start+24; checksum = 0xef
    for _ in range(data[start+1]):
        need(at+8 <= limit, 'Truncated ESP segment header')
        length = struct.unpack_from('<I', data, at+4)[0]; at += 8
        need(0 < length and at+length <= limit, 'Truncated/empty ESP segment')
        for b in data[at:at+length]: checksum ^= b
        at += length
    end = (at//16+1)*16
    need(end <= limit and data[end-1] == checksum, 'ESP image checksum mismatch')
    if data[start+23]:
        need(end+32 <= limit and data[end:end+32] == hashlib.sha256(data[start:end]).digest(), 'ESP image appended digest mismatch')
        end += 32
    return end


def fixed_parts(device, files):
    need(len(files) == 1, 'Expected exactly one device image')
    f = files[0]; n = f['bytes']; name = f['id']
    if device == 'waveshare175c':
        need(256 < n <= 0x600000, 'Waveshare app exceeds factory application slot')
        return [{'file':name,'sourceOffset':0,'length':n,'address':0x200000,'kind':'application'}]
    need(device == 'sticks3' and 0x10100 < n <= 0x340000, 'StickS3 app exceeds approved application map')
    return [{'file':name,'sourceOffset':o,'length':length,'address':o,'kind':kind}
        for o,length,kind in [(0,0x8000,'bootloader'),(0x8000,0x1000,'partitions'),(0xe000,0x2000,'ota'),(0x10000,n-0x10000,'application')]]


def provenance(repo, tag, commit, meta, assets):
    return {'repository':repo,'tag':tag,'commit':commit,'releaseId':meta['id'],
            'assets':{a['name']:{'id':a['id'],'bytes':len(b),'sha256':sha(b)} for a,b in assets}}


def manifest_releases(config, meta, commit, provider, old):
    repo = config['repository']; tag = meta['tag_name']
    raw, ma = asset_bytes(provider, meta, config['manifest'], 1048576)
    m = strict_json(raw)
    need(type(m.get('schemaVersion')) is int and m['schemaVersion'] == 1 and m.get('project') == config['project']
         and m.get('repository') == repo and m.get('tag') == tag and m.get('commit') == commit, 'Release manifest identity differs')
    rows = m.get('releases')
    need(isinstance(rows,list) and len(rows) == len(config['devices']) and {r.get('device') for r in rows} == set(config['devices']),
         'Manifest must contain every configured device exactly once')
    result, blobs = [], {}
    for row in rows:
        device = row['device']; ver = row.get('version'); version(ver, device)
        need(ver.split('-')[0] == tag[1:].split('-')[0], 'Device and release base versions differ')
        files = row.get('files'); need(isinstance(files,list) and len(files) == 1, 'Unexpected release image count')
        f = files[0]; name = f.get('url'); need(isinstance(name,str) and re.fullmatch(r'[A-Za-z0-9._-]+\.bin',name)
             and f.get('id') == name, 'Unsafe or inconsistent firmware filename')
        b, a = asset_bytes(provider,meta,name,0x800000)
        need(type(f.get('bytes')) is int and f['bytes'] == len(b) and f.get('sha256') == sha(b), 'Manifest firmware hash/size mismatch')
        parts = fixed_parts(device, files)
        need(equal(row.get('parts'),parts) and equal(row.get('partitions'),config['devices'][device]['partitions']),
             'Manifest flash layout differs from the approved device contract')
        start = 0 if device == 'waveshare175c' else 0x10000
        end = image(b,start,len(b),0x2000000 if device == 'waveshare175c' else 0x800000)
        need(all(v == 255 for v in b[end:]), 'Unexpected data after application image')
        need(ver.encode() in b[start:], 'Firmware does not contain its declared device version')
        if device == 'sticks3':
            be = image(b,0,0x8000,0x800000)
            need(all(v == 255 for v in b[be:0x8000]) and all(v == 255 for v in b[0x9000:0xe000]), 'Merged image contains unexpected boot padding or NVS data')
        previous = old[device]
        entry = {k:copy.deepcopy(previous[k]) for k in ('description',)}
        entry.update(id=config['project']+'-'+device+'-'+ver,project=config['project'],device=device,version=ver,
            status='Published release',qualification='Published stable release. Automated checks, firmware hashes and the device flash layout passed. This is not a claim of a new physical-device test.',
            source='https://github.com/'+repo+'/tree/'+commit,
            manual='https://github.com/'+repo+'/blob/'+tag+'/'+('README-STICKS3.md' if device == 'sticks3' else 'README-WAVESHARE175C.md'),
            files=[{**f,'url':'firmware/'+name}],parts=parts,partitions=copy.deepcopy(row['partitions']),
            upstream=provenance(repo,tag,commit,meta,[(ma,raw),(a,b)]))
        # Old eligibility descriptions describe an obsolete build, not the project.
        entry['description'] = 'Offline coin/dice seed generation with address QR and cancellable reset.'
        result.append(entry); blobs['firmware/'+name] = b
    return result, blobs


def adapter_releases(config, meta, commit, provider, old):
    if config['adapter'] == 'blackjack': return BJ.releases(SimpleNamespace(**globals()),config,meta,commit,provider)
    if config['adapter'] == 'manifest': return manifest_releases(config,meta,commit,provider,old)
    repo=config['repository']; tag=meta['tag_name']
    if config['adapter'] == 'phoenix':
        data={}; assets=[]
        for name,limit in [(P.APP,0x670000),(P.ASSETS,0x180000),(P.SUMS,65536)]:
            b,a=asset_bytes(provider,meta,name,limit); data[name]=b; assets.append((a,b))
        entry=P.new_release(meta,data)
        need(equal(entry['partitions'],config['devices']['sticks3']['partitions']), 'Phoenix partition map differs from configured contract')
        entry['upstream']=provenance(repo,tag,commit,meta,assets)
        return [entry],{f['url']:data[n] for f,n in zip(entry['files'],[P.APP,P.ASSETS])}
    need(config['adapter'] == 'stopwatch' and set(config['devices']) == {'waveshare175c'}, 'Unsupported release adapter')
    ver=tag[1:]; version(ver)
    b,a=asset_bytes(provider,meta,'stopwatch-app.bin',0x600000)
    checks,ca=asset_bytes(provider,meta,'SHA256SUMS',65536)
    need(P.sums(checks).get('stopwatch-app.bin') == sha(b), 'Stopwatch release checksum mismatch')
    end=image(b,0,len(b),0x2000000)
    need(all(v == 255 for v in b[end:]), 'Unexpected data after Stopwatch application')
    need(b[32:36] == bytes.fromhex('3254cdab') and b[48:80].split(b'\0',1)[0] == ver.encode(), 'Stopwatch embedded version differs')
    name='stopwatch-waveshare175c-'+ver+'.bin'
    files=[{'id':name,'url':'firmware/'+name,'bytes':len(b),'sha256':sha(b)}]
    entry={'id':'stopwatch-waveshare175c-'+ver,'project':'stopwatch','device':'waveshare175c','version':ver,
           'status':'Published release','description':'A button-only stopwatch. Start, pause, lap and reset.',
           'qualification':'Published stable release. Firmware checksum, embedded version and factory application layout verified. Physical and browser testing are separate.',
           'source':'https://github.com/'+repo+'/tree/'+commit,'manual':'https://github.com/'+repo+'/blob/'+tag+'/README.md',
           'files':files,'parts':fixed_parts('waveshare175c',files),
           'partitions':copy.deepcopy(config['devices']['waveshare175c']['partitions']),
           'upstream':provenance(repo,tag,commit,meta,[(a,b),(ca,checks)])}
    return [entry],{'firmware/'+name:b}


def apply_entries(catalog, entries):
    result=copy.deepcopy(catalog)
    for new in entries:
        slots=[(i,r) for i,r in enumerate(result['releases']) if r['project'] == new['project'] and r['device'] == new['device']]
        if not slots and new['project'] == 'blackjack' and new['device'] == 'sticks3':
            need(not any(r['project'] == 'blackjack' for r in result['releases']+result.get('recoveryReleases',[])) and not any(p['id'] == 'blackjack' for p in result['projects']), 'Partial Blackjack bootstrap is not allowed')
            result['projects'].append(copy.deepcopy(BJ.PROJECT))
            result['releases'].append(copy.deepcopy(new))
            continue
        need(len(slots) == 1, 'Expected exactly one existing project/device release')
        i,old=slots[0]; nv=version(new['version'],new['device']); ov=version(old['version'],old['device'])
        need(nv >= ov, 'Refusing firmware downgrade')
        if nv == ov:
            need(equal([(f['bytes'],f['sha256']) for f in old['files']],[(f['bytes'],f['sha256']) for f in new['files']])
                 and equal(old['parts'],new['parts']) and equal(old['partitions'],new['partitions']), 'Same version has different firmware or flash layout')
            # Preserve the device-tested qualification and recovery ID for a no-op.
            # Existing pinned provenance may not be changed under a stable version.
            if old.get('upstream'):
                for key in ('repository','tag','releaseId','commit'):
                    if key in old['upstream']: need(old['upstream'][key] == new['upstream'].get(key), 'Same version upstream identity changed')
                for name,a in old['upstream'].get('assets',{}).items():
                    need(a == new['upstream'].get('assets',{}).get(name), 'Same version asset identity changed')
            continue
        archive=result.setdefault('recoveryReleases',[])
        need(not any(r['id'] == new['id'] for r in archive), 'New release already archived; refusing replay')
        matches=[r for r in archive if r['id'] == old['id']]
        need(not matches or equal(matches,[old]), 'Recovery release ID collision')
        if not matches: archive.append(copy.deepcopy(old))
        result['releases'][i]=copy.deepcopy(new)
    return result


def openssl(*args, data=None):
    r=subprocess.run(['openssl',*map(str,args)],input=data,capture_output=True,timeout=30)
    need(r.returncode == 0,'Release signature operation failed')
    return r.stdout


def key_fingerprint(root):
    der=openssl('pkey','-pubin','-in',root/'release-key.pem','-outform','DER')
    need(len(der) == 44 and der[:12].hex() == '302a300506032b6570032100','Expected Ed25519 public key')
    need(sha(der[-32:]) == TRUSTED_FINGERPRINT,'Release public key differs from the pinned key')
    return der


def signature(root, raw, sig=None, pem=None):
    expected=key_fingerprint(root)
    with tempfile.TemporaryDirectory(prefix='flasher-signing-') as td:
        p=Path(td); (p/'catalog').write_bytes(raw)
        if pem is not None:
            kp=p/'private.pem'; fd=os.open(kp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'wb') as f: f.write(pem.encode())
            actual=openssl('pkey','-in',kp,'-pubout','-outform','DER')
            need(actual == expected,'Signing key differs from the published release key')
            openssl('pkeyutl','-sign','-inkey',kp,'-rawin','-in',p/'catalog','-out',p/'sig')
            sig=(p/'sig').read_bytes()
        need(isinstance(sig,bytes) and len(sig) == 64,'Expected a 64-byte Ed25519 signature')
        (p/'sig').write_bytes(sig)
        openssl('pkeyutl','-verify','-pubin','-inkey',root/'release-key.pem','-rawin','-in',p/'catalog','-sigfile',p/'sig')
    return sig


def validate_files(root, catalog, blobs, node):
    """Use the actual browser flash contract, not a second permissive parser."""
    with tempfile.TemporaryDirectory(prefix='flasher-contract-') as td:
        p=Path(td); paths={}
        for r in catalog['releases']+catalog.get('recoveryReleases',[]):
            for f in r['files']:
                need(re.fullmatch(r'firmware/[A-Za-z0-9._-]+\.bin',f['url']), 'Unsafe versioned firmware path')
                candidate=root/f['url']; need(not candidate.is_symlink(),'Firmware path must not be a symlink')
                b=blobs.get(f['url'])
                if b is None: b=candidate.read_bytes()
                need(len(b) == f['bytes'] and sha(b) == f['sha256'],'Firmware hash/size differs from catalog')
                if candidate.exists(): need(candidate.read_bytes() == b,'Immutable firmware filename already differs')
                if f['url'] not in paths:
                    q=p/str(len(paths)); q.write_bytes(b); paths[f['url']]=str(q)
        (p/'input.json').write_bytes(encoded({'catalog':catalog,'paths':paths}))
        code="""import fs from 'node:fs/promises';import{pathToFileURL}from'node:url';
const [root,input]=process.argv.slice(1);const{validateParts,parsePartitions,samePartitions}=await import(pathToFileURL(root+'/core.js'));
const{validateCatalog}=await import(pathToFileURL(root+'/release-status.js'));
const{catalog,paths}=JSON.parse(await fs.readFile(input,'utf8'));validateCatalog(catalog);for(const r of [...catalog.releases,...(catalog.recoveryReleases||[])]){
const d=catalog.devices.find(d=>d.id===r.device);const files=new Map();for(const f of r.files)files.set(f.id,new Uint8Array(await fs.readFile(paths[f.url])));
const parts=validateParts(r,d,files);const t=parts.find(p=>p.kind==='partitions');if(t&&!samePartitions(parsePartitions(t.data,d.flashBytes),r.partitions))throw Error('Binary partition table differs');}
"""
        r=subprocess.run([node,'--input-type=module','-e',code,str(root),str(p/'input.json')],capture_output=True,timeout=120)
        need(r.returncode == 0,'Browser firmware/partition contract validation failed')


def sync(root, config, provider, node):
    root=Path(root).resolve(); original=(root/'catalog.json').read_bytes()
    signature(root,original,(root/'catalog.sig').read_bytes())
    current=strict_json(original); validate_files(root,current,{},node)
    need(type(config.get('format')) is int and config['format'] == 1,'Unsupported sync configuration')
    updated=copy.deepcopy(current); blobs={}; statuses=[]
    need({c['project'] for c in config['projects']} == set(REPOSITORIES) and len(config['projects']) == len(REPOSITORIES), 'Configure each supported project exactly once')
    for c in config['projects']:
        project=c['project']; repo=c['repository']
        need(REPOSITORIES.get(project) == repo,'Unexpected configured repository')
        status={'project':project,'repository':repo,'tag':None,'releaseUrl':None,'state':'unavailable','message':''}
        try:
            meta=provider.metadata(repo,'releases/latest'); tag=release_metadata(meta,repo)
            status.update(tag=tag,releaseUrl=meta['html_url'],state='blocked')
            pinned=provider.metadata(repo,'releases/tags/'+tag)
            need(release_pin(meta) == release_pin(pinned),'Latest/tag release identity differs')
            commit=source_commit(provider,repo,tag)
            successful_checks(provider,repo,commit,c.get('requiredChecks',[]))
            old={r['device']:r for r in updated['releases'] if r['project'] == project}
            need(set(old) == set(c['devices']) or (project == 'blackjack' and not old),'Configured devices differ from catalog')
            entries,data=adapter_releases(c,meta,commit,provider,old)
            proposed=apply_entries(updated,entries)
            validate_files(root,proposed,{**blobs,**data},node)
            final=provider.metadata(repo,'releases/latest'); final_tag=provider.metadata(repo,'releases/tags/'+tag)
            need(release_pin(meta) == release_pin(final) == release_pin(final_tag),'Release assets changed during verification')
            need(source_commit(provider,repo,tag) == commit,'Source tag changed during verification')
            updated=proposed; blobs.update(data)
            status.update(state='current',message='Latest published stable release verified.')
        except (Invalid,OSError,ValueError,KeyError,TypeError,AttributeError,IndexError,StopIteration,subprocess.TimeoutExpired):
            # Do not expose upstream-controlled strings, tokens, or command stderr.
            error=sys.exc_info()[1]
            status['message']=str(error) if isinstance(error,Invalid) else 'Release validation could not be completed.'
        status['devices']=[{'device':r['device'],'offeredVersion':r['version']} for r in updated['releases'] if r['project'] == project]
        statuses.append(status)
    need((root/'catalog.json').read_bytes() == original,'Catalog changed during sync; rerun against the new parent')
    return updated,blobs,{'checkedAt':datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat(), 'projects':statuses}


def stage(root, destination, catalog, blobs, status, key_env):
    root=Path(root).resolve(); destination=Path(destination).resolve()
    need(not destination.exists() and not destination.is_relative_to(root.parent),'Stage must be new and outside the website checkout')
    old=(root/'catalog.json').read_bytes(); raw=old if equal(strict_json(old),catalog) else encoded(catalog)
    key=os.environ.get(key_env) if key_env else None
    if key:
        # Validate CI key configuration on every run, including a no-op; otherwise
        # a wrong key would remain undiscovered until the next firmware release.
        sig=signature(root,raw,pem=key)
    elif raw == old: sig=signature(root,raw,(root/'catalog.sig').read_bytes())
    else: raise Invalid('Updated catalog requires the configured CI signing key')
    payload={'catalog.json':raw,'catalog.sig':sig,
             'catalog.signed.json':encoded({'format':1,'catalog':base64.b64encode(raw).decode(),'signature':base64.b64encode(sig).decode()}),
             'release-status.json':encoded(status)}
    checks=(root/'firmware/SHA256SUMS').read_bytes()
    for r in catalog['releases']: checks=P.local_sums(checks,r)
    payload['firmware/SHA256SUMS']=checks
    for name,b in blobs.items():
        p=root/name
        need(not p.is_symlink(),'Immutable firmware path is a symlink')
        if p.exists(): need(p.read_bytes() == b,'Immutable filename collision')
        else: payload[name]=b
    destination.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.flasher-release-stage-',dir=destination.parent) as td:
        p=Path(td)/'stage'; p.mkdir()
        for name,b in payload.items():
            out=p/'flasher'/name;out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(b)
        report={'format':1,'baseCatalogSHA256':sha(old),'catalogSHA256':sha(raw),
                'changed':raw != old,'blocked':any(s['state'] != 'current' for s in status['projects']),
                'files':[{'path':'flasher/'+n,'bytes':len(b),'sha256':sha(b)} for n,b in sorted(payload.items())]}
        (p/'PLAN.json').write_bytes(encoded(report))
        need((root/'catalog.json').read_bytes() == old,'Catalog changed before staging')
        os.rename(p,destination)
    return report


def main(argv=None):
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--flasher-root',type=Path,default=HERE.parent)
    ap.add_argument('--config',type=Path)
    ap.add_argument('--node',default=shutil.which('node'))
    group=ap.add_mutually_exclusive_group(required=True)
    group.add_argument('--check',action='store_true');group.add_argument('--stage',type=Path)
    ap.add_argument('--key-env',default='FLASHER_SIGNING_KEY')
    args=ap.parse_args(argv)
    try:
        need(bool(args.node),'Node 22+ is required')
        config=strict_json((args.config or args.flasher_root/'releases.config.json').read_bytes())
        catalog,blobs,status=sync(args.flasher_root,config,GitHub(),args.node)
        result={'status':status,'changed':not equal(catalog,strict_json((args.flasher_root/'catalog.json').read_bytes()))}
        if args.stage: result['stage']=stage(args.flasher_root,args.stage,catalog,blobs,status,args.key_env)
        print(json.dumps(result,indent=2))
        return 1 if any(p['state'] != 'current' for p in status['projects']) else 0
    except (Invalid,OSError,ValueError,KeyError,TypeError,AttributeError,IndexError,subprocess.TimeoutExpired):
        e=sys.exc_info()[1]
        print('Release sync stopped: '+(str(e) if isinstance(e,Invalid) else 'Configuration, storage or validation failure.'),file=sys.stderr)
        return 1


if __name__ == '__main__': sys.exit(main())
