# Desktop distribution

The desktop app shares the classroom frontend and existing backend. This release adds a signed distribution pipeline, a four-platform download catalogue and repeatable publication tools. Public UI is English-only. It does not purchase signing services, register domains, deploy infrastructure or publish an installer automatically when source is pushed.

## Release targets and trust

The signed workflow builds macOS Intel (x64), macOS Apple silicon (arm64), Windows x64 and Windows ARM64 independently from the same immutable main commit. Desktop version `0.2.0` is the first version prepared for this workflow. Existing `apps/desktop/installers` files for version `0.1.0` remain unsigned development snapshots and are never exposed by the new download page.

macOS builds require a Developer ID Application certificate and Apple API notarization credentials. The release verifier mounts each DMG read-only without opening Finder, extracts the ZIP, and checks the application identifier, expected team, CPU architecture, code signature, stapled notarization ticket and Gatekeeper assessment. Windows uses Azure Artifact Signing (the electron-builder 26 `azureSignOptions` integration), checks the application payload's PE architecture, and requires valid timestamped Authenticode signatures from the configured publisher on both payload and installer. Binary product versions must match the release version.

Signing credentials are confined to native release jobs and are not embedded in frontend assets or runtime configuration. The Apple API key is written to a temporary runner file and removed in an always-run cleanup step. The app ID remains `com.nativesfu.classroom`; existing backend-scoped profiles and sign-in/device settings are preserved. Do not change signing identity or app ID without an independently reviewed migration.

Official references for the pinned tooling: [electron-builder 26 macOS signing](https://www.electron.build/v26/docs/features/code-signing/code-signing-mac/), [Windows/Azure signing](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/) and [automatic updates](https://www.electron.build/v26/docs/features/auto-update/). Code signing identifies the publisher; it does not guarantee that every operating-system reputation prompt disappears.

## Configure protected release settings

Use repository variables for public configuration. The current repository token cannot inspect Actions variables or secrets, so their existence has not been verified. Configure protected GitHub environments `desktop-signing-mac` and `desktop-signing-win`, required reviewers, and deployment branch restrictions permitting only main. No fork or pull-request job receives signing credentials.

| Public repository variable | Value |
| --- | --- |
| `SFU_DESKTOP_SERVER_URL` | Existing production backend HTTPS origin, without `/api/v1` |
| `SFU_DESKTOP_WEBSITE_URL` | Existing production website HTTPS origin |
| `SFU_DESKTOP_ADMIN_URL` | Admin portal HTTPS origin for public error explanations |
| `SFU_DESKTOP_DISTRIBUTION_URL` | HTTPS distribution directory, for example your website origin followed by `/desktop-downloads/` |
| `APPLE_TEAM_ID` | Expected ten-character Apple team identifier |
| `SFU_DESKTOP_WIN_PUBLISHER` | Exact signing certificate common name |
| `SFU_DESKTOP_AZURE_ENDPOINT` | Azure regional signing endpoint, such as `https://eus.codesigning.azure.net/` |
| `SFU_DESKTOP_AZURE_ACCOUNT` | Artifact Signing account name |
| `SFU_DESKTOP_AZURE_PROFILE` | Public-trust certificate profile name |

| Protected signing environment | Secrets |
| --- | --- |
| `desktop-signing-mac` | `MAC_CSC_LINK` (electron-builder supported certificate link/base64 P12), `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY_P8` (raw P8 PEM text), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` |
| `desktop-signing-win` | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, scoped to the signing certificate profile |

Production release preflight rejects missing values, loopback/IP/example origins, credentials in URLs, query strings and fragments. The signed builder requires notarization/code signing and an exact runtime/feed configuration. It cannot silently fall back to an unsigned release. `npm run desktop:release:doctor` checks an equivalent locally exported release environment without printing credentials.

## Build a reviewable release bundle

1. Merge tested source and the intended desktop version into main. Update the desktop workspace version and lock file together for each release.
2. Manually dispatch **Signed desktop release bundle** (`.github/workflows/desktop-release.yml`) from main. Enter the exact package version and optional public release notes. The plan captures the workflow commit; all four jobs check out that exact commit. A later main push cannot mix sources into this run.
3. Each native job builds, signs, notarizes where required and stages verified installers. It checks SHA-512/size against electron-builder update metadata and writes SHA-256 checksums and native verification evidence. Unsigned files, wrong architecture/version, missing targets, hash mismatches and source inconsistencies fail the workflow.
4. The assembly job downloads artifacts only from its own workflow run. It requires all four targets and creates `desktop-release-VERSION` as a workflow artifact. Review/download it before publication. No release, tag, CDN or live update feed is created by this workflow.

The bundle layout is:

```text
releases/VERSION/mac/x64/…dmg, …zip and matching blockmaps
releases/VERSION/mac/arm64/…
releases/VERSION/win/x64/…exe and blockmap
releases/VERSION/win/arm64/…
stable/mac/x64/latest-mac.yml
stable/mac/arm64/latest-mac.yml
stable/win/x64/latest.yml
stable/win/arm64/latest.yml
desktop-release.json
bundle-index.json
```

Every update feed points to the immutable, versioned files and records their exact hashes and sizes. Separate platform/architecture feed directories prevent an ARM64 build from replacing Intel update metadata. macOS includes ZIP archives required by the updater as well as DMG installers.

## Publish the reviewed bundle

Choose the existing institution HTTPS hosting or a CDN under the configured distribution URL. For a mounted static web root, run:

```sh
npm run desktop:release:publish -- /path/to/reviewed-bundle /path/to/desktop-web-root
```

The command validates bundle hashes, refuses newer/different releases at the destination, installs immutable assets first, atomically replaces each update pointer, then publishes the download catalogue last. Repeating the same release is safe; existing immutable filenames with different bytes are rejected. Use a filesystem supporting atomic rename. The tool holds an exclusive publication lock. If a publisher crashes, inspect its state before manually removing a stale `.desktop-publication.lock` and retrying. Never edit YAML hashes manually or replace installer bytes under an existing version.

For object storage/CDN hosting, use the same ordering: upload immutable assets, verify their hashes and Range/HEAD responses, publish all four uncached update metadata files, then publish the catalogue. Use conditional writes/generation checks to serialize publishers. Keep older versioned assets so installed clients and in-progress downloads remain valid. The raw catalogue and `bundle-index.json` are not public objects; make the reviewed catalogue available privately to the backend, which exposes the validated public API.

`apps/frontend/nginx.conf` supports `/desktop-downloads/` with a read-only mount at `/srv/desktop-distribution`. It serves versioned bytes with immutable caching, Range/HEAD support and `nosniff`; stable feeds use `no-store`; raw catalogue/evidence files are not served. Missing files return 404 rather than the Angular app. The default image has no mounted release files and exposes no development installer. Add the reviewed volume/mount through the existing deployment process; no deployment was performed for this change.

Mount/copy `desktop-release.json` read-only to the backend and configure:

```text
DESKTOP_RELEASE_MANIFEST=/srv/desktop-distribution/desktop-release.json
DESKTOP_DOWNLOAD_ORIGINS=https://YOUR-ACTUAL-DISTRIBUTION-HOST
```

Origins contain no directory path. The public `/api/v1/desktop/releases` endpoint validates the manifest, version, four target entries, expected filenames, signing status, hashes and allowlisted HTTPS destinations, and strips internal fields. Missing/invalid/unapproved catalogues expose `available:false` with no links. The endpoint is uncached so publication and withdrawal changes are seen on the next page load. `/download` displays the public installers, checksums and installation instructions. The website footer links to it.

Before announcing availability, download each hosted artifact, compare SHA-256 with the reviewed bundle, verify the platform signature/notarization on its native OS, check HTTP 206/HEAD and update metadata, and install on the supported physical architectures. Local synthetic tests do not replace these checks. The publisher must ensure that the catalogue file and allowed origins correspond to the same reviewed release.

## Upgrades and rollback

The updater uses only the baked-in HTTPS feed, refuses prereleases and downgrades, never auto-installs on quit, and does not check/download/install during a flagged active class. Late check/progress events remain deferred. A failed verification clears installation readiness; an older downloaded package cannot be mistaken for a newer candidate. Installation remains an explicit user action outside class.

Test a signed previous/current version pair on Windows x64/ARM64 and macOS Intel/Apple silicon with real credentials and hosting. Verify profile persistence, a restart/update, failed network and invalid signatures, and update deferral through a real lesson. A signed update installation has not been exercised locally because release credentials/production hosting are not configured.

To withdraw public downloads, remove/replace the backend catalogue configuration; existing downloaded bytes cannot be recalled. To pause updates, stop publishing new feed metadata while retaining immutable files. To recover a faulty release, publish a corrected higher version after native testing; do not point feeds to a lower version or weaken signature verification. Website/backend code rollback can retain the additive catalogue endpoint and static release mount.

## Automated validation

- `npm test -w @native-sfu/desktop`: runtime URL/proxy/permission tests, update races, release preflight, native-evidence gates, hash/architecture checks, complete bundle assembly and publication protections. Release unit fixtures are synthetic and cannot be produced by the signing CLI as a verified public release.
- `npm run test:desktop:hosting`: actual Nginx container checks for exact bytes, HTTP HEAD/Range, caching and missing-file behavior. It removes only its own labelled test container.
- Backend desktop/config unit tests validate catalogue filtering, file bounds and failure states.
- `npm run test:desktop:distribution:browser`: real backend and headless Chromium/Firefox/WebKit, unpublished/approved/invalid catalogues, desktop/tablet/mobile layouts, dark mode, accessibility and actual screenshots in `reports/desktop-distribution`.
- Ordinary desktop CI runs validation without signing secrets. Native unsigned packaging remains a development check, separate from the manually dispatched signed release workflow.
