"""Strict two-file Blackjack release adapter; no device data is an input."""
import copy
import re

CONTRACT = 'blackjack-sticks3-v1'
BOOT_BYTES = 15104
BOOT_SHA = '1776e4dd896a69d0a5c2e79957b0e2a88aa4129b1381d6478683515a1f6af343'
OTA_SHA = 'f94c5d786a7a8fab06ac5d10e33bf37711a6697636dc037559ea19cc410a17f0'
PARTITIONS = [dict(type=t,subtype=s,offset=o,size=n,label=l,flags=0) for t,s,o,n,l in [
 (1,2,0x9000,0x5000,'nvs'),(1,0,0xe000,0x2000,'otadata'),(0,16,0x10000,0x600000,'app0'),
 (1,130,0x610000,0x160000,'reserved'),(1,65,0x770000,0x80000,'rustresume'),(1,64,0x7f0000,0x2000,'rustsave')]]
PROJECT = dict(id='blackjack',name='Blackjack Trainer',category='Training',url='https://github.com/xberenguer/blackjack-trainer')


def parts(app, install, size):
    return [dict(file=f,sourceOffset=s,length=n,address=a,kind=k) for f,s,n,a,k in [
      (install,0,0x8000,0,'bootloader'),(install,0x8000,0x1000,0x8000,'partitions'),
      (install,0xe000,0x2000,0xe000,'ota'),(app,0,size,0x10000,'application')]]


def releases(S, config, meta, commit, provider):
    need = S.need
    repo=config['repository'];tag=meta['tag_name'];ver=tag[1:]
    need(re.fullmatch(r'\d+\.\d+\.\d+',ver) is not None, 'Blackjack requires a stable numeric tag')
    S.version(ver)
    need(config.get('manifest') == 'flasher-release.json' and config.get('requiredChecks') == ['native']
         and set(config['devices']) == {'sticks3'} and S.equal(config['devices']['sticks3']['partitions'],PARTITIONS), 'Blackjack configured contract differs')
    raw,ma=S.asset_bytes(provider,meta,'flasher-release.json',1048576)
    m=S.strict_json(raw)
    need(type(m.get('schemaVersion')) is int and m['schemaVersion'] == 1 and m.get('project') == 'blackjack'
         and m.get('repository') == repo and m.get('tag') == tag and m.get('commit') == commit, 'Blackjack manifest identity differs')
    rows=m.get('releases');need(isinstance(rows,list) and len(rows) == 1,'Blackjack requires exactly one device')
    row=rows[0]
    need(row.get('device') == 'sticks3' and row.get('version') == ver and row.get('contract') == CONTRACT,'Blackjack device/version/contract differs')
    fs=row.get('files');need(isinstance(fs,list) and len(fs) == 2,'Blackjack requires exactly two files')
    expected=['blackjack-sticks3-app.bin','blackjack-sticks3-install.bin']
    need([f.get('id') for f in fs] == expected and all(f.get('url') == f['id'] for f in fs),'Blackjack filenames differ')
    data={};assets=[(ma,raw)]
    for f in fs:
        b,a=S.asset_bytes(provider,meta,f['id'],0x610000)
        need(type(f.get('bytes')) is int and f['bytes'] == len(b) and f.get('sha256') == S.sha(b),'Blackjack manifest firmware hash/size differs')
        data[f['id']]=b;assets.append((a,b))
    app,merged=[data[n] for n in expected]
    need(256 < len(app) <= 0x600000 and len(merged) == 0x10000+len(app) and merged[0x10000:] == app,'Blackjack app/install payloads differ')
    need(S.equal(row.get('parts'),parts(*expected,len(app))) and S.equal(row.get('partitions'),PARTITIONS),'Blackjack flash layout differs')
    end=S.image(app,0,len(app),0x800000)
    need(all(v == 255 for v in app[end:]) and app[32:36] == bytes.fromhex('3254cdab') and app[48:80].split(b'\0',1)[0] == ver.encode(),'Blackjack embedded version or image padding differs')
    bootend=S.image(merged,0,0x8000,0x800000)
    need(bootend == BOOT_BYTES and S.sha(merged[:BOOT_BYTES]) == BOOT_SHA
         and all(v == 255 for v in merged[bootend:0x8000]),'Blackjack bootloader is not the qualified public build')
    need(all(v == 255 for v in merged[0x9000:0xe000]) and S.sha(merged[0xe000:0x10000]) == OTA_SHA,'Blackjack NVS gap or qualified OTA bytes differ')
    checks,ca=S.asset_bytes(provider,meta,'SHA256SUMS',65536);assets.append((ca,checks));sums=S.P.sums(checks)
    need(all(sums.get(n) == S.sha(b) for n,b in [(expected[0],app),(expected[1],merged),('flasher-release.json',raw)]),'Blackjack release checksums differ')
    local=[f'blackjack-sticks3-{ver}-app.bin',f'blackjack-sticks3-{ver}-install.bin']
    files=[dict(id=n,url='firmware/'+n,bytes=len(data[old]),sha256=S.sha(data[old])) for n,old in zip(local,expected)]
    entry=dict(id='blackjack-sticks3-'+ver,project='blackjack',device='sticks3',version=ver,contract=CONTRACT,
      status='Preview',description='Offline blackjack, Hi-Lo practice, drills and session analysis with two-button controls.',
      qualification='Stable firmware release: native CI, source identity, image checksums and exact flash layout verified. The browser StickS3 installation and migration path remains a preview pending physical qualification.',
      source='https://github.com/'+repo+'/tree/'+commit,manual='https://github.com/'+repo+'/blob/'+tag+'/docs/INSTALL.md',
      files=files,parts=parts(*local,len(app)),partitions=copy.deepcopy(PARTITIONS),upstream=S.provenance(repo,tag,commit,meta,assets))
    return [entry],{'firmware/'+n:data[old] for n,old in zip(local,expected)}
