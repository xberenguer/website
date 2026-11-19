# Blackjack Trainer flash contract

Blackjack uses the existing signed catalog, central signing key, stable GitHub release checks and scheduled synchronization. The configured source is `xberenguer/blackjack-trainer`, project ID `blackjack`, devices `sticks3` (ESP32-S3, exactly 8 MiB) and `waveshare175c` (ESP32-S3, exactly 32 MiB). The required source-commit check is `native`. No draft, prerelease, unsigned catalog, arbitrary address or cross-repository asset is accepted.

This browser installation and migration path remains **Preview** until it is physically qualified. Software loader tests exercise planning, preservation and recovery; they do not establish USB installation or power-loss behavior on hardware.

## Release assets

A stable `vX.Y.Z` GitHub release must contain:

- `blackjack-sticks3-app.bin`: an ESP32-S3 8 MiB application image, at most `0x600000` bytes. Its ESP app descriptor must contain exactly `X.Y.Z`.
- `blackjack-sticks3-install.bin`: exactly `0x10000 + app length` bytes. Its suffix at `0x10000` must equal the separate app byte for byte. This is a public build bundle, never a device dump.
- `flasher-release.json`: schema 1 with project `blackjack`, repository `xberenguer/blackjack-trainer`, exact release tag and resolved 40-character source commit. The first `sticks3` row declares version `X.Y.Z`, contract `blackjack-sticks3-v1`, the two files in app/install order, their byte lengths/SHA-256, the four slices below and the six partition rows below.
- `blackjack-waveshare175c-app.bin`: the additional application-only round image required from 0.12.0 onward; its contract is below.
- `SHA256SUMS`: flat SHA-256 entries for every binary **and** `flasher-release.json`.

Each manifest file has identical `id` and `url`, equal to the release asset name. Upstream files are pinned to the release tag. The signed website catalog renames them to `blackjack-sticks3-X.Y.Z-app.bin` and `blackjack-sticks3-X.Y.Z-install.bin`; existing immutable files cannot be overwritten.

The manifest slices are:

| File | Source offset | Length | Flash address | Kind |
| --- | ---: | ---: | ---: | --- |
| install | `0` | `0x8000` | `0` | bootloader |
| install | `0x8000` | `0x1000` | `0x8000` | partitions |
| install | `0xe000` | `0x2000` | `0xe000` | ota |
| app | `0` | actual app length | `0x10000` | application |

Only the compiled public 15104-byte bootloader with SHA-256 `1776e4dd896a69d0a5c2e79957b0e2a88aa4129b1381d6478683515a1f6af343` is accepted, followed by erased `FF` bytes through `0x8000`. It must also pass ESP segment/checksum/digest validation. The OTA slice must hash to `f94c5d786a7a8fab06ac5d10e33bf37711a6697636dc037559ea19cc410a17f0`. The merged NVS gap `[0x9000,0xe000)` must be entirely `FF`, and is never a write slice. No private/public journal payload belongs in the release bundle.

## StickS3 exact partition rows

Flags are zero. Ordered rows must match in type, subtype, offset, size, label and flags; the actual binary table is parsed independently, including its checksum/footer.

| Type | Subtype | Offset | Size | Label |
| ---: | ---: | ---: | ---: | --- |
| `1` | `2` | `0x9000` | `0x5000` | nvs |
| `1` | `0` | `0xe000` | `0x2000` | otadata |
| `0` | `16` | `0x10000` | `0x600000` | app0 |
| `1` | `130` | `0x610000` | `0x160000` | reserved |
| `1` | `65` | `0x770000` | `0x80000` | rustresume |
| `1` | `64` | `0x7f0000` | `0x2000` | rustsave |

## Update and migration behavior

When the connected table matches all six rows exactly, only the application slice is compared and updated. Bootloader, table, OTA, NVS and both journals remain untouched. The installer does not read either journal on this compatible path.

For a different valid partition map, the installer plans the four bounded install slices. Each journal is considered **independently**: if the current table already has that journal's exact typed row, its bytes are preserved. Otherwise the exact newly claimed journal range is initialized to erased `FF`; recovery capture is optional. For example, an older Blackjack layout with a compatible `rustsave` row retains its public totals when `rustresume` is introduced. A foreign project's contents in newly claimed storage are replaced as part of the explicit migration; a prominent optional backup offer appears before flashing. Choosing Advanced backup includes those sectors in the recovery file. Any planned overlap with a current typed NVS partition is rejected.

The default flow is Connect → Flash → Verify. Full recovery reads and file saving are optional under Advanced; unused bytes in a partial app sector are preserved with a bounded tail-sector read. The default path still checks original device-side range digests. Immediately before writing, the installer rechecks device identity, original range digests and the original table hash. No erase-all or eFuse operation is used. Recovery restores all changed sectors, including StickS3 journal initialization, and remains usable if an interrupted table cannot parse. It is constrained to that signed release's exact slices plus its two fixed journal ranges. Generic projects gain no new write permission at or above `0x7f0000`.

The `.bflash` recovery file stays on the user's computer. During replacement it may contain old session/journal data, so it must not be published or uploaded as a release asset. A disconnected device can prevent automatic rollback; retain the backup for explicit recovery of the same MAC/chip/capacity.

## Waveshare round contract, 0.12.0 onward

A release at 0.12.0 or newer must declare exactly two rows, **StickS3 first, Waveshare second**, at the same version and source commit. Validation and catalog promotion are atomic. Older 0.11.x one-device releases remain accepted; adding this target does not invalidate an existing Stick recovery contract.

The round row uses contract `blackjack-waveshare175c-v1` and exactly one upstream asset, `blackjack-waveshare175c-app.bin`. Its sole slice starts at source offset zero, flashes at **0x200000**, and has kind `application`. The signed local filename is `blackjack-waveshare175c-X.Y.Z-app.bin`. The image must identify ESP32-S3, **32 MiB** flash and the exact release version in its standard app descriptor. Its maximum length is **0x570000** bytes: a firmware payload, including its final sector, ends no later than **0x770000**.

The connected device must retain this exact factory map; there is no round layout migration:

| Type | Subtype | Offset | Size | Label |
| ---: | ---: | ---: | ---: | --- |
| 1 | 2 | `0x9000` | `0x32000` | nvsfactory |
| 1 | 2 | `0x3b000` | `0xd2000` | nvs |
| 1 | 0 | `0x10d000` | `0x2000` | otadata |
| 1 | 1 | `0x10f000` | `0x1000` | phy_init |
| 1 | 130 | `0x110000` | `0xf0000` | model |
| 0 | 0 | `0x200000` | `0x600000` | factory |
| 1 | 130 | `0x800000` | `0x800000` | storage |

Flags are zero. The installer neither writes the partition table nor initializes private/public journals inside the unused factory tail. Factory bootloader, NVS, model, storage, and **0x770000–0x7f2000** session regions are excluded from the round release's installation and recovery authority. Selecting Advanced backup captures only the overwritten application sectors and their preserved final-sector tail. A recovery file cannot add journal ranges or borrow the Stick's special journal permissions. A damaged live partition table can still be recovered from an already validated application backup.

The physical controls and 270-degree orientation belong to the source-bound Rust firmware. The public build packager requires its button-only/orientation proof and linked stack audit; there is no touch-driven installer or game dependency.

## Discovery and first publication

The existing central workflow runs approximately every 15 minutes and supports manual dispatch. It signs and publishes Blackjack only after all checks pass, independently of other projects. The first valid release adds the project/card atomically; a missing or invalid release leaves it absent and reports a blocked/unavailable check in the workflow and release-status file. Subsequent promotions archive the old signed recovery contract. The current preview label is retained by this adapter, independently of firmware release status.

Local verification (no network or device required):

```sh
node --test flasher/tests/*.test.js
python3 -m unittest discover -s flasher/tests -p 'test_*.py'
```


A prepared local package can be checked without publication or network access:

```sh
python3 flasher/scripts/check-blackjack.py --release-dir /path/to/public-package --tag vX.Y.Z --commit SOURCE_COMMIT_40_HEX --node /path/to/node
```

This verifies the local manifest's supplied identity and actual binary/browser contracts. The scheduled GitHub workflow separately verifies the real tag, successful `native` check and release asset identities.

An optional actual-Chrome UI test is `node flasher/tests/blackjack-browser.cjs` with Playwright available and, if needed, `BROWSER_EXECUTABLE` pointing to Chrome. It serves a synthetic release signed with an ephemeral test key and cancels a fake port chooser. It checks the deep link, preview label, board filtering and confirmation gates; it performs no USB operation and is not installer hardware qualification. `BROWSER_TEST_OUTPUT` optionally saves its synthetic fixture screenshot outside the published site.
