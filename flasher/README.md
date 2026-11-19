# Browser firmware installer

**Waveshare browser installation is verified; StickS3 remains in preview.** Firmware and browser-path qualification are recorded separately for each build.

Live at **[🌠🌌.ws/flasher](https://xn--sg8hhb.ws/flasher/)**. Static files on the existing GitHub Pages site. No backend, accounts, analytics or runtime CDN dependency. The website home page links here directly below Game Builder.

## Releases

The installer follows the newest **published stable GitHub release** for each configured project and device. It does not follow development commits, drafts or prereleases. Exact versions, source releases, validation status and last synchronization time appear on each project card; `catalog.json` is the authoritative list of offered artifacts.

| Project | Device | Release source |
|---|---|---|
| Seeder Fork | StickS3 / K150 and Waveshare AMOLED 1.75C | [Seeder Fork releases](https://github.com/xberenguer/Seeder-Fork/releases) |
| Phoenix Link / Confucius Say | StickS3 / K150 | [Phoenix releases](https://github.com/xberenguer/phoenix-link-confucius-say/releases) |
| Stopwatch | Waveshare AMOLED 1.75C | [Stopwatch releases](https://github.com/xberenguer/stopwatch/releases) |
| Blackjack Trainer | StickS3 / K150 (browser path: Preview) | [Blackjack releases](https://github.com/xberenguer/blackjack-trainer/releases) |

A published release is not a claim of physical testing for that exact binary. Hardware results remain separately stated. Missing, invalid or incomplete upstream releases leave the previous verified files available with an explicit blocked/unavailable status. Checks older than 45 minutes are marked unconfirmed. Previews are not automatically promoted into stable installs.

Retired/unfinished pocketwatch, StatTrak and roulette builds are excluded. Raspberry Pi games link to their SD images/builders; Web Serial does not write SD cards.

## Use

1. Open the HTTPS page in desktop Chrome, Edge or another Web Serial browser. Use a USB data cable and close serial monitors.
2. Select the exact device and project. Review the version, qualification, manual and file hashes.
3. Put the board in flashing mode, confirm its physical model and click Connect. A chip/flash-capacity check alone cannot identify the display model.
4. Prepare: the release catalog signature and firmware SHA-256 are checked; current flash sectors are read and verified. Save the `.bflash` recovery file before installing.
5. Install, wait for byte verification, then restart and inspect the screen/buttons.

Flashing restarts the board. Save any current seed first. Recovery files cover flash sectors, not the seed held in volatile RAM. Private backup bytes and the session device MAC stay local. The server receives normal page/download requests only.

## Live console and progress

Every project uses the same expanded installation panel: **Connect → Prepare → Save backup → Flash & verify**. Release details and exact files remain available in the expandable disclosure.

The console shows real esptool messages plus the operations actually being performed: downloads, SHA-256 checks, partition/range comparison, verified recovery reads, flash writes and final device-side verification. File/range addresses and byte counts are included. Download bars use bytes actually received; write bars use esptool's compressed-transfer callbacks. Final verification has its own stage: transferring 100% does not finish installation. When an install fails, the failure and any verified automatic recovery stay in the log.

**Copy log** and **Download log** export a local text transcript. The display keeps the latest 600 lines, strips terminal control codes and masks device MAC addresses. Scroll/touch the console to inspect earlier lines; scrolling back to the bottom resumes following. This is installation activity, not a serial monitor for a running application; no application output, seed contents or backup payload bytes are logged.

The [Bitronics Web Flasher](https://github.com/BitMaker-hub/bitronics-web-flasher) informed the console/progress presentation. This implementation uses the existing pinned transport and verification flow with its own UI code.

Optional isolated Chrome acceptance (Playwright required):

```sh
node flasher/tests/activity-browser.cjs
```

`FLASHER_PLAYWRIGHT_MODULE` and `BROWSER_EXECUTABLE` can select an existing Playwright installation and Chrome. The test uses the real signed catalogue and installer with a simulated USB module, covering all offered project/device combinations, streamed files, save gates, transfer/verification separation, log download, mobile rendering and failed-write rollback. It never opens a physical port. `BROWSER_TEST_OUTPUT` optionally saves clearly labelled synthetic screenshots.

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

## Add or publish a release

See [release maintenance](RELEASING.md). Publish checked firmware in the project's GitHub Releases; the central workflow validates, signs, tests and deploys the corresponding catalog update. No manual whole-catalog bundle is required. New hardware still requires an explicitly reviewed device profile and flash contract.

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

## Automatic release synchronization

`Sync firmware releases` runs every 15 minutes, supports manual dispatch, and accepts the `firmware-released` repository event. GitHub may delay scheduled jobs; the page shows the actual check time. The workflow handles all configured projects independently, archives replaced contracts for recovery, and verifies the live deployment after publication. Failed promotions produce a failed workflow and visible project status.

The browser loads one `catalog.signed.json` envelope containing the exact catalog bytes and Ed25519 signature. It then checks firmware SHA-256 and existing board/backup/write constraints. Idle tabs refresh every five minutes or when returning to the tab; an open installer keeps its selected artifact fixed.

The signing key is an encrypted GitHub Actions environment secret restricted to the website's `main` branch. It is never committed or served. Project releases carry bounded, pinned asset identities; the website independently checks their bytes and flash layout before signing. [Signing and trust model](SIGNING.md).

The old Phoenix-specific scripts remain for verifying historical bundles, but their scheduled workflow is retired. Do not use an old whole-catalog bundle to replace the current multi-project catalog.


## Blackjack Trainer

The dedicated [Blackjack flash contract](BLACKJACK.md) adds the StickS3 trainer through the same signed, stable-release pipeline. Its card appears after the first complete release passes validation; no placeholder firmware is offered. Compatible Blackjack layouts receive an app-only update, preserving NVS and both journals. A layout migration backs up and initializes only newly claimed, precisely typed journal regions. Keep the resulting recovery file private: it may contain prior session data.

The Blackjack browser installation/migration path is **Preview** pending physical browser qualification. Native tests and device validation of the firmware do not qualify the browser transport. Automatic discovery uses the existing scheduled workflow; a failed release check retains the last signed offering.
