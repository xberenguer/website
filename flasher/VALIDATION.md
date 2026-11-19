# Flasher validation

Firmware qualification and browser-installer qualification are separate. This page records the tested scope; it does not claim camera scanning, battery runtime, complete RAM erasure or an independent security audit.

| Item | Observed result |
| --- | --- |
| Signed catalog | Ed25519 verification passes in the browser and independently with the signing tool; modified/missing/wrong-key signatures are rejected |
| Software checks | 29 passing checks cover firmware hashes/maps, protected offsets, failure/recovery handling, archived-release backups and the serial reader |
| Waveshare `.9` terminal path | Guarded app-only installation with verified backup, followed by independent ROM digest verification |
| Waveshare `.9` Chrome path | Connect/32MB identity, exact factory map, signed download hash, full 708608-byte backup read and verification, actual recovery-file save, app-only install, device digest verification and restart all passed |
| Repeated hardware reads | Three complete table reads and three 64KiB app reads matched the signed firmware reference |
| Recovery-file validation | The saved file was independently checked for the correct device, app-only range, complete prior firmware, SHA-256 and MD5; it remains private |
| Recovery import UI | Real saved backup and public archived-release fixture both open the correct recovery flow |
| Restore writes | Covered by software tests; a real hardware restore write remains pending |
| Post-browser ROM check | Pending; the identical `.9` artifact had already passed a separate ROM check before the browser install |
| StickS3 `.1` | Previous green build was flashed/ROM-verified and menu/both buttons physically confirmed. The updated browser transport has not completed a StickS3 hardware install |
| StickS3 `.3` | Automated release packaging verifies the corrected splash bitmap in the compiled app. This exact CI release has not been physically tested. See the signed catalog for the offered build. |
| Phoenix `.93` | Frozen installed/byte-verified preview; final display/audio acceptance remains pending |

## Previously physically checked Seeder artifacts

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `seeder-sticks3-2.2.0-sticks3.1-merged.bin` | 812448 | `4aacbe515abb924d2c88eb1f33845e32453d431a9ed7571f592467a9055f68c2` |
| `seeder-waveshare175c-2.2.0-ws175c.9.bin` | 706272 | `a6f43313ecd21f7b09432205a0405ba0f5b0dec655ba74335c3d78bb4731a0b7` |

The Waveshare app is installed at `0x200000`; factory bootloader, partition table, NVS, model and storage are excluded from its write plan. StickS3 uses explicit slices of its merged file and skips NVS. Whole-chip erase is not used.

The browser uses a persistent packet reader and 128-byte read payloads. Even a fully escaped data frame stays at or below 258 wire bytes. Larger native-USB read frames were intermittently truncated during development; the bounded configuration passed the repeated reads and full Waveshare installation above. A partial read invalidates that session and requires fresh detection; it is never resumed by resending ACKs.

The signed catalog binds hashes, offsets, device maps and versions. It does not enable Secure Boot or program eFuses. The website and devices remain usable with other projects. Private signing material and device recovery files are kept outside the published site.

## Stopwatch 1.0.0 — November 16, 2026

- Exact 162,000-byte native Rust application, SHA-256 `092b94c642f199717a090e213cfb65bfde5c5ce5a5734e74c6ccfec2d4fc1886`.
- Installed on the 32 MB Waveshare 1.75C with the verified Python installer, with private overwritten-sector backup, read-back verification and restart.
- All 11 Rust host tests pass. The compact refactor's five preview states are pixel-identical to the preceding physically confirmed clean-text build.
- Chrome local preview: project page Install link opens the Stopwatch 1.0.0 modal, selects Waveshare, and keeps Connect disabled until model confirmation.
- Real Chrome USB connection detected ESP32-S3 / 32 MB, verified the signed download and factory partition table, compared the device application digest, and reported “Already up to date.” Restart/disconnect completed. This check did not write flash; it does not qualify this release's browser backup/install/restore-write path.
- 33 Node installer checks and 52 Python release-sync checks pass. The new Stopwatch test exercises the shipped application's app-only install, sector-tail preservation and backup restoration with a fake loader.

## Automatic releases — November 17, 2026

- 41 JavaScript checks cover signed atomic catalog loading, schema validation, stale status, immutable installer selection, image/device contracts, recovery and USB transport.
- 66 Python checks cover release validation, automated signing, project isolation, tag/asset races, same-version immutability, fixed maps and historical bundle compatibility.
- Seeder release packaging has 22 checks, including exact corrected StickS3 splash pixels in the compiled image and clean version/source provenance.
- The website signing environment is restricted to the main branch; the existing trusted public key is unchanged.
- No USB connection, physical flash or hardware acceptance was performed for this pipeline update. Browser automation was unavailable during this run; the actual signing/installer modules were exercised by tests.
- Deployment is verified separately by comparing the live atomic catalog, detached signature and active firmware SHA-256 with the publication. Each automatic sync records its check/deployment outcome in GitHub Actions.


## Blackjack adapter — November 18, 2026

- 47 JavaScript installer checks and 73 Python release/publishing checks pass, with no skipped tests. The dedicated Blackjack regressions cover exact-map app-only updates without journal reads; independently preserved typed public/private journals; bounded first-install migration and initialization; every affected sector in the recovery backup; damaged-table recovery; interrupted-write rollback; foreign NVS rejection; and untrusted recovery files unable to extend write authority.
- The separate release adapter rejects mismatched source identity, changed app/install payloads, invalid maps/slices, NVS data, altered OTA bytes, missing checksums, and a different otherwise-valid bootloader. Its source CI requirement is exactly `native`; it does not inherit physical testing claims.
- The actual public `v0.11.3` package at source `cbb6c0d831691a2fbb7b3df365170bddcf9a3694` passes the offline adapter and actual JavaScript catalog/partition contract. Its app is 3,352,832 bytes, SHA-256 `50d47e4702087dad5fe4ca9510dbaca04a4825e8ea5b06d29f678c2468509335`. This local check does not verify published GitHub CI or prove browser hardware installation.
- Actual Chrome passes an explicitly synthetic release/card UI smoke, using an ephemeral test signer and cancelled fake port chooser: signed loading, Blackjack deep link, Preview/manual/file presentation, board filtering, model confirmation and disabled installation without a saved backup. No physical USB device is accessed.
- The existing trusted signing key, generic protected ranges and security checks are unchanged. No signed catalog or firmware is manually substituted. The first real offering is added only by the existing verified signing/sync pipeline.
- **Blackjack browser installation/migration remains Preview. No physical installation, restore write or power-loss qualification is claimed for this adapter.** Native firmware device validation is separate.


## Shared activity console — November 19, 2026

- The shared installation panel now includes four explicit steps, real phase/file progress, a bounded timestamped console, and local Copy/Download actions for every project. Genuine esptool terminal output is connected to the display; progress percentages come from received download bytes or the actual compressed-write callback. Unknown-duration work stays indeterminate.
- New regressions cover streamed download accounting, truncation/oversize/corruption rejection, diagnostic callback isolation, bounded/control-safe transcripts, transfer-before-verification ordering and truthful rollback events. Existing write-range, signature, backup, migration and recovery contracts are retained.
- Actual Chrome acceptance uses the real signed catalogue and core with an explicitly simulated USB module. All five offered board/project combinations show the console; a complete Blackjack flow checks SHA-256, verified backup, the save gate, visible 50% progress, separate final MD5 verification, log download, responsive rendering and verified recovery after an injected interrupted write.
- Screenshots generated by this test are labelled **SIMULATED USB TEST · NO DEVICE CONNECTED**. No physical flash or new hardware qualification is claimed. Runtime dependencies remain vendored locally; Bitronics served as a presentation reference.
