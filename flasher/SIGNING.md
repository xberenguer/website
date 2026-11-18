# Release signatures

The browser verifies an **Ed25519 signature over the exact bytes of `catalog.json`** before exposing installation. The signed catalog binds each firmware filename, version, device, flash offsets, partition map, byte size and SHA-256. Downloads must then match those signed hashes. Device-side MD5 verifies the bytes written to flash.

This signs the release manifest, not the ESP32 Secure Boot image format. It does not change bootloaders, provision trust keys in hardware, write eFuses or lock either device. Secure Boot is a separate, deferred project.

## Trusted public key

[Download the release public key](release-key.pem). It is also pinned in `signing.js`. SHA-256 of the raw 32-byte Ed25519 public key:

```text
34568ae48435426bb68028eb6f3bb338a2cba5115c906a33ca26c3592c31c5d4
```

Compare this fingerprint with a previously trusted copy. The matching public key and fingerprint are also published in [Seeder Fork](https://github.com/xberenguer/Seeder-Fork/blob/master/docs/release-signatures.md). A website attacker could replace both checking JavaScript and its public key; an in-page “verified” badge alone cannot protect against complete website compromise. The signing private key is not in this repository or on the website. Automated signing uses the encrypted `FLASHER_SIGNING_KEY` secret in the `flasher-release` GitHub Actions environment, restricted to the website main branch. A private maintainer backup is retained outside the checkout. Trusted workflow code can use this key, so repository administration and workflow changes are part of the trust boundary.

## Verify independently

Use a trusted installation of OpenSSL 3 or later. Download `catalog.json`, `catalog.sig`, `release-key.pem` and the desired firmware files, keeping their relative `firmware/` directory. Check the public-key fingerprint first:

```sh
openssl pkey -pubin -in release-key.pem -outform DER | tail -c 32 | shasum -a 256
openssl pkeyutl -verify -pubin -inkey release-key.pem -rawin -in catalog.json -sigfile catalog.sig
```

Only after signature verification succeeds, compare the downloaded firmware size/SHA-256 to its entries in the signed catalog. `firmware/SHA256SUMS` is provided for convenience; it is not separately signed and must not replace the signed catalog as the authority. Seeder's [source-build and mask-ROM verification instructions](https://github.com/xberenguer/Seeder-Fork/blob/master/docs/flashing.md) provide a separate installation route.

## Maintain releases

Keep the private key outside the website checkout and back it up privately. Use `scripts/sign-catalog.py --key /private/location/key.pem` with the Python `cryptography` package. The script requires the already-published public key to match, checks every firmware file's size/hash, signs the exact catalog bytes, verifies the result, and emits only the detached signature. It does not create, print or upload a private key.

Any change to the catalog requires a new signature. Publish the catalog, signature and pinned checker together. Tests reject a modified catalog, a missing/corrupt signature and a signature made by a different key. Firmware file corruption is rejected separately.

The central multi-project workflow now signs the catalog after checking published stable GitHub releases, asset identities/digests, embedded firmware versions and fixed board maps. Firmware repositories do not need to sign a copy of the entire website catalog. The legacy Phoenix signed bundles are retained only for historical verification.

The browser fetches `catalog.signed.json`, one atomic envelope with base64-encoded exact catalog bytes and the detached signature. Separate `catalog.json`/`catalog.sig` remain available for independent verification. A signature proves the approved catalog and firmware hashes; it does not prove the catalog is the newest available release. `release-status.json` supplies advisory check times and failure reasons, and stale checks are explicitly marked unconfirmed. It never authorizes firmware.

Losing this **browser release-signing key** does not lock a device: the boards have no hardware Secure Boot rule. A replacement browser release key would require a clearly announced public-key change. This differs from losing a key after permanent device Secure Boot provisioning.
