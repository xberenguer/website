# Browser firmware installer

Live at **[🌠🌌.ws/flasher](https://xn--sg8hhb.ws/flasher/)**. Static files on the existing GitHub Pages site. No backend, accounts, analytics or runtime CDN dependency. The website home page links here directly below Game Builder.

## Catalog

| Project | Device | Frozen build | Status |
|---|---|---|---|
| Seeder Fork | M5Stack StickS3 / K150 | `2.2.0-sticks3.1`, original green palette | Flashed and ROM-verified |
| Seeder Fork | Waveshare AMOLED 1.75C | `2.2.0-ws175c.8` | Previously flashed and readback-verified |
| Phoenix Link / Confucius Say | M5Stack StickS3 / K150 | `0.2.93` candidate | Preview; installed and byte-verified, final physical display/audio acceptance pending |

This catalog contains the selected tested binaries, not automatically the newest commit in another project. Retired/unfinished pocketwatch, StatTrak and roulette builds are excluded. Raspberry Pi games link to their image downloads/builders; Web Serial does not write Raspberry Pi SD cards.

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
- Skip ranges already matching the selected image. Back up every affected 4KB sector and preserve its final unused tail in the new write buffer. Configure the stub's flash geometry in RAM, read each 64KB range as 512-byte framed packets with cumulative acknowledgments, consume and verify the trailing digest, then verify the full range against the device MD5.
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

The tests exercise all shipped file sizes/hashes/maps, wrong devices, corrupt tables/downloads/backups, protected ranges, sector-tail preservation, identity changes, successful installs, interrupted writes, verified rollback and disconnected recovery using a fake loader. The vendored API was also exercised separately against esptool-js's compressed-write/read-digest behavior. Browser QA covers device filtering, both installer panels, confirmation gating and cancelled USB selection. **The new browser installer still needs physical end-to-end qualification on both boards; prior terminal firmware qualification does not substitute for that.** The latest framed-read transport fix passes protocol/failure tests but has not yet been tested on USB hardware. No destructive power-loss experiment has been performed.

## Add a release

Freeze an independently qualified artifact. Retain the exact binary, build/source identity, dependency notices, byte size and SHA-256. Add one catalog record with exact allowed slices and partition map; add a device profile only when its flash/recovery contract is implemented. Keep previous releases for recovery compatibility. Run the tests, browser-test the target flow, then qualify connect/backup/install/verification/reset and physical operation on the actual hardware before calling that browser path device-tested. Do not point an installer at mutable/latest binaries.

## Hosting and upkeep

GitHub Pages serves the static site and roughly 9MB of selected firmware under the existing domain. No additional paid service is required for this implementation; hosting remains subject to GitHub Pages limits. Upkeep is versioned artifacts, license/source links, a current catalog and occasional browser/device regression testing. Adding releases does not require a server.

Original Seeder credit: **[BitMaker](https://github.com/BitMaker-hub/Seeder)** and **Lunaticoin**. [Fork manuals and every deviation](https://github.com/xberenguer/Seeder-Fork). [Licenses and notices](NOTICES.txt).
