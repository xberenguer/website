#!/usr/bin/env python3
"""Sign exact catalog bytes locally. The private key must remain outside this repo.

Requires cryptography. Usage: python scripts/sign-catalog.py --key /private/key.pem
No key is generated, uploaded or printed by this script.
"""
import argparse
from pathlib import Path
import hashlib
import json
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--key', required=True, type=Path)
args = parser.parse_args()
key_path = args.key.resolve()
if key_path.is_relative_to(root.parent):
    raise SystemExit('Keep the private signing key outside the website repository.')
key = serialization.load_pem_private_key(key_path.read_bytes(), password=None)
if not isinstance(key, Ed25519PrivateKey):
    raise SystemExit('Expected an Ed25519 release key.')
expected = serialization.load_pem_public_key((root / 'release-key.pem').read_bytes())
raw = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
expected_raw = expected.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
if raw != expected_raw:
    raise SystemExit('Signing key differs from the published release key. Do not rotate keys silently.')
catalog_bytes = (root / 'catalog.json').read_bytes()
catalog = json.loads(catalog_bytes)
for release in [*catalog['releases'], *catalog.get('recoveryReleases', [])]:
    for item in release['files']:
        path = (root / item['url']).resolve()
        if not path.is_relative_to(root / 'firmware'):
            raise SystemExit('Firmware path must stay within the firmware directory.')
        data = path.read_bytes()
        if len(data) != item['bytes'] or hashlib.sha256(data).hexdigest() != item['sha256']:
            raise SystemExit('Firmware hash/size mismatch: ' + item['id'])
signature = key.sign(catalog_bytes)
expected.verify(signature, catalog_bytes)
(root / 'catalog.sig').write_bytes(signature)
print('Catalog signed and signature independently verified.')
