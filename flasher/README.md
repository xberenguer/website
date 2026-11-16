# Browser firmware installer

**Waveshare browser installation is verified; StickS3 remains in preview.** Firmware and browser-path qualification are recorded separately for each build.

Live at **[🌠🌌.ws/flasher](https://xn--sg8hhb.ws/flasher/)**. Static files on the existing GitHub Pages site. No backend, accounts, analytics or runtime CDN dependency. The website home page links here directly below Game Builder.

## Catalog

| Project | Device | Frozen build | Status |
|---|---|---|---|
| Seeder Fork | M5Stack StickS3 / K150 | `2.2.0-sticks3.1`, original green palette | Flashed and ROM-verified |
| Seeder Fork | Waveshare AMOLED 1.75C | `2.2.0-ws175c.9` | App-only install with verified backup and independent ROM verification; reset visuals await acceptance |
| Stopwatch | Waveshare AMOLED 1.75C | `1.0.0` | Rust firmware installed and read-back verified; browser path not separately qualified |
| Phoenix Link / Confucius Say | M5Stack StickS3 / K150 | Exact latest published release pinned in the signed catalog | Firmware and browser-install qualification are recorded separately |

The signed catalog pins exact published files. Phoenix updates are prepared from its latest stable GitHub release; a source commit without a published release is not installed. Retired/unfinished pocketwatch, StatTrak and roulette builds are excluded. Raspberry Pi games link to their image downloads/builders; Web Serial does not write Raspberry Pi SD cards.

## Use

1. Open the HTTPS page in desktop Chrome, Edge or another Web Serial browser. Use a USB data cable and close serial monitors.
2. Select the exact device and project. Review the version, qualification, manual and file hashes.
3. Put the board in flashing mode, confirm its physical model and click Connect. A chip/flash-capacity check alone cannot identify the display model.
4. Prepare: the release catalog signature and firmware SHA-256 are checked; current flash sectors are read and verified. Save the `.bflash` recovery file before installing.
5. Install, wait for byte verification, then restart and inspect the screen/buttons.

Flashing restarts the board. Save any current seed first. Recovery files cover flash sectors, not the seed held in volatile RAM. Private backup bytes and the session device MAC stay local. The server receives normal page/download requests only.

## Flash contract

- Ed25519 verification of the signed release catalog before showing installation, using a pinned public key. See [release signatures and independent verification](SIGNING.md).
- ESPLoader and Transport from vendored **esptool-js 0.7.1**; no whole-chip erase, no header rewriting, compressed stub writes only.
- The ROM security check rejects secure-boot, secure-download and encrypted devices. Require ESP32-S3 image ID 9, expected flash capacity and a valid device identity.
- Read exactly 4KB of partition table, parse every record, validate bounds/overlap/labels/checksum/footer. An erased terminator is accepted only with all-FF remaining bytes.
- Waveshare: require the complete ordered factory map; write only the selected app at `0x200000`, within its 6MB slot. No bootloader, table, NVS, model, storage or OTA-data writes.
- StickS3: validate the current table before preparation. Split the verified merged file into boot `[0,0x8000)`, table `[0x8000,0x9000)`, OTA `[0xe000,0x10000)` and app `[0x10000,end)` slices. Preserve the release's exact OTA bytes. Skip NVS `[0x9000,0xe000)`. Phoenix additionally installs its asset file at `0x670000`. A different map is explicitly described as project replacement.
- Skip ranges already matching the selected image. Back up every affected 4KB sector and preserve its final unused tail in the new write buffer. Configure the stub's flash geometry in RAM, read each 64KB range as 128-byte framed packets with cumulative acknowledgments, consume and verify the trailing digest, then verify the full range against the device MD5.
- Save a SHA-256/MD5-checked recovery container before enabling Install. File System Access confirms the save completed; download fallback requires an explicit saved-file acknowledgement.
- Recheck the same MAC/chip/capacity, old range digests and table hash immediately before writing. All serial commands are sequential. No cancellation during an in-flight flash operation.
- Verify each written range. On a failed write, attempt restoration of all changed sectors and verify it. A disconnected device can prevent recovery: retain the file and reconnect the same board. Recovery deliberately does not require a potentially interrupted live partition table to parse. Imported ranges are constrained to the catalog's exact sector ranges.
- Reset only after verified installation/recovery or a session that did not modify flash. Flash verification is not proof of physical UI behavior, security or entropy quality.

## Recovery container

`.bflash` is eight-byte `BFLASH1\0`, a four-byte little-endian JSON byte length, UTF-8 JSON, then concatenated raw sector ranges. Format 1 records the catalog release/device, chip/capacity/MAC, old table SHA-256, and each range's address/length/SHA-256/MD5. It is a private recovery artifact, never a file to publish. No user-supplied arbitrary flash offset is accepted. Keep the corresponding catalog release when updating the site so old recovery files remain supported.

## Develop and validate

No build step or npm install is needed. Serve the repository root with a static HTTP server; loopback qualifies as a secure browser context.

```sh
cd flasher
node --test tests/*.test.js
cd ..
python3 -m http.server 8767 --bind 127.0.0.1
```

The tests exercise all shipped file sizes/hashes/maps, wrong devices, corrupt tables/downloads/backups, protected ranges, sector-tail preservation, identity changes, successful installs, interrupted writes, verified rollback and disconnected recovery using a fake loader. The vendored API was also exercised separately against esptool-js's compressed-write/read-digest behavior. Browser QA covers device filtering, both installer panels, confirmation gating and cancelled USB selection. **Waveshare .9 passed a full Chrome install:** signature/SHA-256, complete factory map, 708608-byte verified backup, actual private recovery file save, explicit app-only write, device MD5 and restart. Three additional table reads and three 64KiB reads matched the signed reference. The StickS3 browser path still needs hardware qualification; its installed firmware baseline was independently ROM-verified. A hardware restore-write test and post-browser independent ROM check remain pending; the same .9 artifact had already passed a separate ROM check. No destructive power-loss experiment has been performed.

## Add a release

Freeze an independently qualified artifact. Retain the exact binary, build/source identity, dependency notices, byte size and SHA-256. Add one catalog record with exact allowed slices and partition map; add a device profile only when its flash/recovery contract is implemented. Keep previous releases for recovery compatibility. Run the tests, browser-test the target flow, then qualify connect/backup/install/verification/reset and physical operation on the actual hardware before calling that browser path device-tested. Do not point an installer at mutable/latest binaries.

## Hosting and upkeep

GitHub Pages serves the static site and selected firmware under the existing domain. No additional paid service is required for this implementation; hosting remains subject to GitHub Pages limits. Upkeep is versioned artifacts, license/source links, a current catalog and occasional browser/device regression testing. Adding releases does not require a server.

Original Seeder credit: **[BitMaker](https://github.com/BitMaker-hub/Seeder)** and **Lunaticoin**. [Fork manuals and every deviation](https://github.com/xberenguer/Seeder-Fork). [Licenses and notices](NOTICES.txt).

## Recovery across updates

Previous release contracts are retained in the signed `recoveryReleases` catalog. They are hidden from the current-project list but remain available when validating an existing `.bflash` recovery file. Device identity, exact permitted offsets/sector lengths and backup hashes are still checked. Retain the matching old binary and checksum when updating the current release.

## USB read transport

`serial-transport.js` keeps one continuous Web Serial reader and a bounded SLIP packet queue. Stream errors fail pending reads immediately; missing output streams fail ACK writes. Flash-read failures invalidate the connection and require fresh detection before preparation can be retried. The pinned vendor bundle is unchanged.

Read payloads are 128 bytes, so even fully escaped frames are at most 258 wire bytes. Larger native-USB read frames were intermittently truncated on the test board. The bounded frames passed repeated hardware reads and the full backup/install flow. The software tests also cover fragmentation, coalescing, escaping, stream failures, lock release and frame-size bounds.

For a development read check only, open `tests/usb-read.html` on the same local server. It resets a Waveshare 1.75C and uploads the stub to RAM, then compares table/firmware reads with signed references; it never writes flash. Use public test inputs and save any active seed first.

[Recorded validation and exact firmware hashes](VALIDATION.md). Recovery imports were checked with both the real saved file and a public archived-release fixture; no restore write was attempted after the round board became unavailable.

## Prepare a Phoenix release update

The `Sync signed Phoenix release` GitHub Actions workflow checks every fifteen minutes and supports an immediate manual dispatch. It consumes `flasher-catalog.json` and `flasher-catalog.sig` attached to the latest stable Phoenix release. The signature, firmware hashes, image layout and exact catalog change are verified before updating the website. Previous Phoenix contracts remain available for recovery. An incompatible or unsigned release leaves the current installer unchanged.

The release publisher runs the local helper after publishing the tested game binaries:

```sh
python3 flasher/scripts/publish-phoenix-bundle.py \
  --tag v0.2.110 --key /private/location/key.pem \
  --work-dir /tmp/new-phoenix-release-bundle --upload
```

This helper requires the existing signing environment, Node 22+ and authenticated GitHub CLI. It signs locally, uploads only the public catalog and detached signature, then dispatches the website workflow. The private key is never uploaded. Use a new work directory for each attempt. Publication of local development versions remains a separate maintainer decision.

`python3 scripts/sync-phoenix.py --dry-run` checks only the public `xberenguer/phoenix-link-confucius-say` repository. It rejects drafts/prereleases, downgrades, changed bytes under the same version, corrupt images and incompatible partition maps. It checks the current signature and retained recovery files first. Use Node 22+ on PATH or `--node /path/to/node`.

Use `--expected-tag v0.2.110 --stage /outside/website/phoenix-update` from the local milestone release workflow. The stage contains versioned local binaries and an unsigned catalog, retaining the prior Phoenix contract for recovery. The helper never signs, commits, deploys or contacts a board. The release workflow owns signing and publication; the private signing key stays local. Publish catalog/signature and files together after the usual checks. The browser continues to fetch only same-origin, signed, immutable files.

`--check` returns 3 when an update is available, 0 when current, and 1 on validation/network failure. `--fixture-dir` exercises the same validators with explicit offline test inputs; it is not proof of a live GitHub publication. Run `python3 tests/test_sync_phoenix.py` and the existing Node tests before integrating an updater change.
