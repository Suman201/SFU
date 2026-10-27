# EDCONNECTION Classroom desktop

Windows and macOS share the Angular classroom and existing NestJS/SFU backend. The desktop has two home tabs (Upcoming classes and Recordings), small settings, and the shared full classroom. Administration remains on the website.

## Run and build

From the repository root, with Node 22.22.3 or later:

```sh
cd /Volumes/Extarnal/RND/SFU
npm ci
npm run desktop:dev
```

The dev command builds the shared Angular desktop interface, copies fresh assets, and launches Electron. It uses the existing local backend at `http://127.0.0.1:3000` and website at `http://localhost:4200`. Start the existing backend separately; the app does not start a duplicate backend.

All commands accept the same platform-neutral arguments on Windows and Mac:

```sh
npm run desktop:dev -- --server-url https://api.school.example --website-url https://school.example
npm run desktop:build -- --server-url https://api.school.example --website-url https://school.example
npm run desktop:package:mac -- --server-url https://api.school.example --website-url https://school.example
npm run desktop:package:win -- --server-url https://api.school.example --website-url https://school.example
npm run desktop:dev -- --help
```

Replace the example URLs with the institution's existing backend and website. `desktop:build` produces an unpacked app for the current computer; the packaging commands produce installers on the appropriate native OS runner. Every command rebuilds Angular first. Direct desktop workspace build/package commands also compile the desktop interface, so a fresh root workspace build does not depend on previously generated desktop assets. Installer packaging requires an explicit server URL to avoid shipping a misconfigured app. `--update-url https://updates.school.example/classroom` additionally configures the signed app update feed.

`SFU_DESKTOP_SERVER_URL`, `SFU_DESKTOP_WEBSITE_URL`, and `SFU_DESKTOP_UPDATE_URL` remain supported for deployment automation; command-line arguments take precedence. The backend must be an origin without `/api/v1`. HTTPS is required except on loopback development servers. A packaged app without a configured server reports a misconfigured installer; teachers and students are never asked to choose backend addresses. No credentials are embedded in installers.

The frontend is bundled and served from a per-install, stable loopback origin. The local proxy forwards `/api/` and `/socket.io/` to the configured backend. It forwards bearer authorization, strips local browser cookies, enforces origin and host checks, and never accepts a backend URL from invitation query parameters. Both app and browser participants use the same server data and live rooms. Persistent authentication and local recovery data are isolated by backend origin, so changing institution configuration does not reuse another institution's session.

Mac installers target Intel and Apple Silicon; Windows installers target x64 and ARM64. `.github/workflows/desktop.yml` provides native OS build jobs and retains unsigned validation installers as workflow artifacts. It does not publish releases or upload binaries to a distribution service. Configure institution URL variables in the workflow before distributing an artifact.

Code signing and notarization use electron-builder's standard certificate environment variables. Development builds can be unsigned; distribute signed Windows installers and signed/notarized Mac builds. Certificates, Apple developer credentials, a Windows runner, and production distribution infrastructure are not included in this repository.

The app icon is derived from the shared website logo at `apps/frontend/src/assets/brand/edconnection-mark.svg`. To regenerate its Windows and Mac resolutions after a deliberate brand change, run `npm run icons -w @native-sfu/desktop` (requires the Playwright Chromium browser).

## Backend requirements

Use the existing backend with `RECORDING_DRIVER=local` for playable lesson recordings. FFmpeg is required for recording finalization and is included in the backend Docker image. If the backend runs in multiple replicas, the recording directory must be on a shared filesystem accessible to every replica. Legacy JSON recording manifests are not playable video and are shown as unavailable; they are not presented as completed recordings.

## Native behavior

- `sfu-classroom://join?sessionId=SESSION&batchId=BATCH` opens the correct classroom after authentication. The role is resolved by the frontend/backend rather than trusting a URL. A running app receives the invitation; a cold app retains it for login.
- Native reminders are optional and fire within five minutes of a scheduled class while the app is running. They do not promise notifications after the user quits the app. Clicking one opens its classroom.
- The camera/microphone use system permissions. Screen sharing uses the system picker where supported, with a dedicated screen/window chooser as fallback. Sources are never selected automatically. Mac entitlements and usage descriptions are included.
- A class-active flag prevents accidental closing and blocks update installation. The app never installs updates automatically on quit. Starting a class cancels any update download.
- A problem report is exported only after the user presses the relevant control and chooses a save location. Diagnostic details are optional; reports exclude tokens, passwords, chat, board contents, device labels, and user emails.

## Whiteboard sources

The web and installed classroom use the same **Whiteboard source** control:

- **Classroom whiteboard** keeps the shared drawing tools, pages, and collaboration.
- **Share device whiteboard** lets the presenter choose a screen or window showing their device's whiteboard software. Viewers see its video; editing stays on the presenter's device. The existing classroom board is preserved when switching back.

Students request permission, then the teacher allows a presenter from the participant list. Permission is required by the server even for older settings that previously allowed automatic sharing. Revoking permission or disconnecting stops the student's capture; rejoining requires fresh approval. A class that explicitly disables student screen sharing remains disabled. The recording follows the selected device presentation, including an approved student's presentation.

This uses the existing screen-capture and SFU paths. It does not discover vendor whiteboard apps, import proprietary board files, or remotely control a device. The device must expose its board through a screen/window that the browser or desktop OS can capture. Standalone hardware may require its vendor's mirroring software. Physical whiteboard hardware compatibility has not yet been tested.

## Updates

Set `SFU_DESKTOP_UPDATE_URL` to the institution's HTTPS electron-updater generic feed before packaging. This is build configuration, not renderer-controlled input. The feed must contain the matching platform update metadata and signed artifacts. Without a feed, Settings explicitly says updates are managed by the institution; no dummy "up to date" result is returned.

The normal packaging commands use `--publish never`. Supplying `--update-url` generates the platform update-provider metadata and requires code signing at build time. Configure signing in your release infrastructure, then upload the generated update metadata and matching signed installers to the configured feed. A real update feed and signed previous/current builds are required to acceptance-test installation end to end.

## Test

```sh
npm test -w @native-sfu/desktop
```

Runtime tests verify trusted URLs/deep links, reminders, local API and WebSocket forwarding, and update deferral.

`npm run test:native -w @native-sfu/desktop` runs the Electron-teacher/browser-student scenario after both frontend configurations have been built. It requires an isolated acceptance backend on 3351, MongoDB on 27028 with the dedicated `whiteboard_acceptance` database, and Redis on 6394. Supply test account credentials through `SFU_NATIVE_TEACHER_EMAIL`, `SFU_NATIVE_STUDENT_EMAIL`, and `SFU_NATIVE_TEST_PASSWORD`; no credentials are stored in the script. It creates unique test class records in that isolated database. Optional `SFU_NATIVE_TEST_BACKEND` and `SFU_NATIVE_TEST_WEBSITE` override the local endpoint, while `SFU_NATIVE_REPORT_DIR` controls screenshots and JSON evidence. The backend must stay local; this command is not intended for a production database. It verifies preflight, actual SFU board video/audio reception, bidirectional whiteboard drawing, granted student control, reload/rejoin, persisted content, and ending the class. It uses synthetic camera/microphone devices and closes its own app/browser windows afterward. The full teacher/student acceptance suite must use the real backend, with both app and web participants, and verify classroom media, board synchronization, reconnects, and recording playback.

For automated Electron tests only, unpackaged builds support `SFU_DESKTOP_USER_DATA` (isolated profile), `SFU_DESKTOP_FRONTEND_DIR` (built interface directory), and `SFU_DESKTOP_TEST_MEDIA=1` (Chromium synthetic camera/microphone). Packaged apps ignore the profile/frontend/test-media overrides. Synthetic devices do not replace physical camera, microphone, screen-capture, or stylus acceptance on each OS.
