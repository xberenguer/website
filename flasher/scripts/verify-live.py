#!/usr/bin/env python3
"""Check the deployed atomic catalog, detached signature and active firmware."""
import argparse, base64, hashlib, json, time, urllib.request
from pathlib import Path
from cryptography.hazmat.primitives import serialization

def digest(data): return hashlib.sha256(data).hexdigest()

def verify(root, base, fetch):
    raw=fetch(base+'catalog.signed.json',4*1024*1024)
    # Deployment identity is byte exact, not just equivalent parsed JSON.
    assert raw==(root/'catalog.signed.json').read_bytes(), 'Deployed catalog envelope differs from this publication'
    envelope=json.loads(raw); assert envelope['format']==1
    catalog=base64.b64decode(envelope['catalog'],validate=True)
    signature=base64.b64decode(envelope['signature'],validate=True)
    key=serialization.load_pem_public_key((root/'release-key.pem').read_bytes())
    key.verify(signature,catalog)
    assert catalog==fetch(base+'catalog.json',2*1024*1024), 'Detached catalog differs'
    assert signature==fetch(base+'catalog.sig',64), 'Detached signature differs'
    status=fetch(base+'release-status.json',1024*1024)
    assert status==(root/'release-status.json').read_bytes(), 'Deployed release-check status differs'
    count=0
    for release in json.loads(catalog)['releases']:
        for f in release['files']:
            assert f['url']=='firmware/'+f['id'] and '/' not in f['id'] and '..' not in f['id']
            data=fetch(base+f['url'],f['bytes'])
            assert len(data)==f['bytes'] and digest(data)==f['sha256'], 'Live firmware mismatch: '+f['id']
            count+=1
    return count

def download(url,limit):
    req=urllib.request.Request(url,headers={'Cache-Control':'no-cache','User-Agent':'Flasher-Live-Verification'})
    with urllib.request.urlopen(req,timeout=30) as r:
        data=r.read(limit+1)
    assert len(data)<=limit, 'Oversized live response'
    return data

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--url',required=True);p.add_argument('--attempts',type=int,default=1);p.add_argument('--interval',type=float,default=10);a=p.parse_args()
    assert a.url.startswith('https://') and 1<=a.attempts<=30 and 0<=a.interval<=30
    root=Path(__file__).resolve().parents[1]
    for attempt in range(a.attempts):
        try:
            count=verify(root,a.url.rstrip('/')+'/',download)
            print(f'Live atomic catalog and Ed25519 signature match; {count} active firmware files match their signed SHA-256.');return
        except Exception as e:
            print(f'Live verification {attempt+1}/{a.attempts}: {type(e).__name__}: {e}',flush=True)
            if attempt+1==a.attempts:raise SystemExit(1)
            time.sleep(a.interval)

if __name__=='__main__': main()
