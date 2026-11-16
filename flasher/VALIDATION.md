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
| StickS3 `.3` | Source and host/build checks are published in Seeder Fork; it has not been flashed and is not in this catalog |
| Phoenix `.93` | Frozen installed/byte-verified preview; final display/audio acceptance remains pending |

## Exact current Seeder artifacts

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
