#!/usr/bin/env python3
"""Read-only offline check of the real Blackjack release assets and browser contract.
This does not substitute for GitHub native CI, tag verification or physical testing.
"""
import argparse
import datetime
import importlib.util
import json
from pathlib import Path
import re
import shutil

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('local_blackjack_sync',HERE/'sync-releases.py')
S=importlib.util.module_from_spec(spec);spec.loader.exec_module(S)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-dir',required=True,type=Path)
    parser.add_argument('--tag',required=True)
    parser.add_argument('--commit',required=True)
    parser.add_argument('--node',default=shutil.which('node'))
    args=parser.parse_args()
    S.need(re.fullmatch(r'v\d+\.\d+\.\d+',args.tag) and re.fullmatch(r'[0-9a-f]{40}',args.commit),'Expected stable tag and lowercase source commit')
    S.need(args.node is not None,'Node 22+ required (--node path)')
    directory=args.release_dir.resolve();root=HERE.parent;repo=S.REPOSITORIES['blackjack']
    assets={}
    for name,limit in [('flasher-release.json',1048576),('blackjack-sticks3-app.bin',0x600000),('blackjack-sticks3-install.bin',0x610000),('SHA256SUMS',65536)]:
        file=directory/name
        S.need(file.is_file() and not file.is_symlink() and 0 < file.stat().st_size <= limit,'Missing, symlinked or oversized release asset: '+name)
        assets[name]=file.read_bytes()
    meta=dict(id=1,tag_name=args.tag,target_commitish=args.commit,draft=False,prerelease=False,
      published_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),html_url='https://github.com/'+repo+'/releases/tag/'+args.tag,
      assets=[dict(id=i+1,name=n,size=len(b),digest='sha256:'+S.sha(b),browser_download_url='https://github.com/'+repo+'/releases/download/'+args.tag+'/'+n) for i,(n,b) in enumerate(assets.items())])
    S.release_metadata(meta,repo)
    class Local:
        def download(self,url,limit):
            prefix='https://github.com/'+repo+'/releases/download/'+args.tag+'/'
            S.need(url.startswith(prefix) and url[len(prefix):] in assets,'Unexpected local asset URL')
            data=assets[url[len(prefix):]];S.need(len(data)<=limit,'Local asset exceeds limit');return data
    config=next(c for c in S.strict_json((root/'releases.config.json').read_bytes())['projects'] if c['project']=='blackjack')
    entries,blobs=S.BJ.releases(S,config,meta,args.commit,Local())
    raw=(root/'catalog.json').read_bytes();S.signature(root,raw,(root/'catalog.sig').read_bytes())
    catalog=S.apply_entries(S.strict_json(raw),entries)
    S.validate_files(root,catalog,blobs,args.node)
    print(json.dumps(dict(status='LOCAL_CONTRACT_VALID',tag=args.tag,commit=args.commit,files=entries[0]['files'],
      caveat='Offline assets/browser-contract check only; GitHub tag/native CI and physical browser installation are separate.'),indent=2))


if __name__=='__main__':
    try:main()
    except (S.Invalid,OSError,ValueError,KeyError,TypeError) as error:
        raise SystemExit('LOCAL_CONTRACT_REJECTED: '+str(error))
