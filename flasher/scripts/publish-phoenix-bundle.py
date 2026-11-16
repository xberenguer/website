#!/usr/bin/env python3
"""Prepare and optionally upload the locally signed Phoenix flasher catalog.

Run after publishing the tested game release. The signing key stays local;
the website's scheduled workflow consumes only the signed public bundle.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

REPO = 'xberenguer/phoenix-link-confucius-say'
WEBSITE = 'xberenguer/website'


def run(command):
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--key', type=Path, required=True)
    parser.add_argument('--work-dir', type=Path, required=True,
                        help='New private staging directory outside the website checkout')
    parser.add_argument('--flasher-root', type=Path,
                        default=Path(__file__).resolve().parents[1])
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--gh', default=shutil.which('gh'))
    parser.add_argument('--upload', action='store_true')
    parser.add_argument('--replace-metadata', action='store_true',
                        help='Replace existing signed metadata after reviewing the new bundle')
    args = parser.parse_args()
    root, work, key = args.flasher_root.resolve(), args.work_dir.resolve(), args.key.resolve()
    if not args.node or not args.gh:
        parser.error('Node 22+ and GitHub CLI are required')
    if work.exists() or work.is_relative_to(root.parent):
        parser.error('--work-dir must be new and outside the website checkout')
    if key.is_relative_to(root.parent):
        parser.error('Keep the signing key outside the website checkout')
    work.mkdir(parents=True)
    # Read credentials only in the existing local signer. Never copy a key.
    run([args.node, str(root/'scripts/check-phoenix.mjs'), str(root), 'existing'])
    stage = work/'unsigned'
    output = json.loads(run([sys.executable, str(root/'scripts/sync-phoenix.py'),
                            '--flasher-root', str(root), '--node', args.node,
                            '--expected-tag', args.tag, '--stage', str(stage)]))
    if output['changed']:
        signing = work/'signing/flasher'
        shutil.copytree(root, signing, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        for row in output['stage']['copyAllowlist']:
            source = stage/row['path']
            if hashlib.sha256(source.read_bytes()).hexdigest() != row['sha256']:
                raise RuntimeError('Staged file changed before signing')
            target = signing.parent/row['path']
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        run([sys.executable, str(signing/'scripts/sign-catalog.py'), '--key', str(key)])
        run([args.node, str(root/'scripts/check-phoenix.mjs'), str(signing), 'existing'])
    else:
        # The current catalog already contains this exact immutable firmware.
        signing = root
    bundle = work/'bundle'
    bundle.mkdir()
    for source, target in [('catalog.json', 'flasher-catalog.json'),
                           ('catalog.sig', 'flasher-catalog.sig')]:
        shutil.copyfile(signing/source, bundle/target)
    files = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in bundle.iterdir()}
    result = {'status': 'SIGNED_BUNDLE_PREPARED', 'tag': args.tag,
              'files': files, 'privateKeyExported': False, 'uploaded': False}
    if args.upload:
        # Refuse to attach a bundle to a tag that has ceased to be latest.
        latest = json.loads(run([args.gh, 'api', f'repos/{REPO}/releases/latest']))
        if latest['tag_name'] != args.tag or latest['draft'] or latest['prerelease']:
            raise RuntimeError('Latest stable release changed before metadata upload')
        existing = {a['name']: a for a in latest['assets']}
        pending = []
        for name, digest in files.items():
            previous = existing.get(name)
            if previous and previous.get('digest') == 'sha256:'+digest:
                continue
            if previous and not args.replace_metadata:
                raise RuntimeError('Different signed metadata already exists; review before --replace-metadata')
            pending.append(str(bundle/name))
        if pending:
            command = [args.gh, 'release', 'upload', args.tag, *pending, '--repo', REPO]
            if args.replace_metadata:
                command.append('--clobber')
            run(command)
        # The workflow verifies signatures and hashes again before deployment.
        run([args.gh, 'workflow', 'run', 'phoenix-release-sync.yml', '--repo', WEBSITE])
        result.update(status='SIGNED_BUNDLE_UPLOADED_SYNC_DISPATCHED', uploaded=True)
    (work/'RESULT.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, KeyError) as error:
        print('Phoenix bundle stopped: '+str(error), file=sys.stderr)
        raise SystemExit(1)
