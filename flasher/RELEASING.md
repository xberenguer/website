# Firmware releases and flasher maintenance

## What users receive

The newest published **stable** GitHub release for each supported project, after the website's independent validation passes. A commit, CI artifact, draft or prerelease is not an installable stable release. Physical testing is recorded separately; never transfer an old binary's hardware qualification to a new build.

The configuration is [`releases.config.json`](releases.config.json). The signed catalog freezes each selected file's bytes, SHA-256, source identity, board, flash slices and partition map. URLs shown in the installer remain same-origin versioned files. Saved recovery contracts and binaries are retained when a release is replaced.

## Publish Seeder

1. Merge the intended changes into `xberenguer/Seeder-Fork`. Increase the version for every device whose binary changes, including changes to its embedded source footer. Never replace bytes under an existing device version.
2. In that repository's **Actions → build → Run workflow**, enter a new bundle tag such as `v2.2.0-ports.2`. Leave the release tag empty for checks only.
3. Calculation, UI, workflow, QR and firmware matrix checks must pass. The final release job packages both board images, `flasher-release.json` and flat `SHA256SUMS`; it uploads to a draft and publishes only after the complete asset set is verified. The bundle tag and individual board versions serve different purposes.
4. The website discovers the release on its next scheduled run. Run **website → Actions → Sync firmware releases** for an immediate check.

The StickS3 image is merged with bounded boot/table/OTA/app slices and skipped NVS. The Waveshare image is **application only at `0x200000`**; its factory bootloader, partition map and storage are preserved. These contracts are not interchangeable.

## Publish Phoenix or Stopwatch

Publish the firmware and checksums using that project's release process. Phoenix requires `phoenix-confucius-sticks3.bin`, `feature-assets.bin` and `SHA256SUMS.txt`; Stopwatch requires `stopwatch-app.bin` and `SHA256SUMS`. Tags must be stable `vX.Y.Z` versions. The central updater validates the assets and supported device contract; it no longer needs the legacy locally signed whole-catalog bundle.

## Publish Blackjack

Publish `xberenguer/blackjack-trainer` as a stable `vX.Y.Z` release after its source commit passes the GitHub Actions `native` check. Include `blackjack-sticks3-app.bin`, `blackjack-sticks3-install.bin`, `flasher-release.json` and `SHA256SUMS`. Follow the exact [Blackjack two-file contract](BLACKJACK.md); existing generic merged-image contracts do not apply. The adapter independently binds the manifest to the release repository, tag and resolved source commit, checks both binary identities and qualified boot/OTA bytes, then creates immutable versioned website filenames. Never replace an existing version.

## Automatic synchronization

`Sync firmware releases` runs approximately every 15 minutes and on manual dispatch. `repository_dispatch` with event type `firmware-released` can request an immediate run using an appropriately scoped credential; no cross-repository token is required for the scheduled fallback. GitHub schedules are best effort, not an exact delivery guarantee.

The job checks each project's latest stable release before and after downloading, resolves the tag to its source commit, enforces configured CI gates, hashes every asset and validates actual ESP images and fixed flash maps. Downgrades, missing boards, changed same-version bytes and incompatible maps stop that project's promotion. Other valid projects can advance; failures remain visible on the page and fail the workflow.

Only after validation does it use `FLASHER_SIGNING_KEY` in the main-only `flasher-release` environment. It publishes the catalog, detached signature, atomic envelope, status and immutable firmware together, then requests a Pages build and verifies the deployed signature and active firmware hashes. A website commit alone is not deployment evidence.

## Diagnose an update

- Check the workflow summary and the project's **Release sync** message on the flasher.
- Verify the release is published, stable, complete and has a source tag.
- A missing signing secret blocks changes; it must not fall back to unsigned firmware.
- “This version is already installed” compares the device with the selected immutable artifact. It does not assert that development source is current.
- If another publication changed `main`, the push fails rather than force-overwriting it. Rerun the workflow against the new parent.
- For a failed deployment, rerun synchronization; the live verifier checks the selected catalog and binaries again.

## Local checks

Use Node 22+, Python 3.12+, OpenSSL 3+ and Python `cryptography` for independent live verification.

```sh
node --test flasher/tests/*.test.js
python3 -m unittest discover -s flasher/tests -p 'test_*.py'
python3 flasher/scripts/sync-releases.py --check
python3 flasher/scripts/verify-live.py --url https://xn--sg8hhb.ws/flasher/
```

`--check` is read-only. Staging requires a new directory outside the website checkout and the signing key in the named environment variable. Never put the private key in a command argument, release asset, repository or browser bundle. Secure Boot/eFuses are unrelated and remain unchanged.

## Publish Scenic Flight

Publish a stable `vX.Y.Z` release from `xberenguer/scenic-flight` with `scenic-flight-waveshare175c-app.bin` and `SHA256SUMS`. The ESP image must contain the release version and the `scenic-flight-waveshare` application name. The flasher offers it for the measured Voxel Flight partition layout only. It backs up the app at `0x10000` before replacing it and preserves the partition table and storage. A standard factory-layout Waveshare needs a separately qualified release.
