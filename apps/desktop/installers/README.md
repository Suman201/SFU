# Classroom installers

All installers below are built from the shared classroom implementation in this commit. The binaries and matching blockmaps are stored in Git LFS. Install Git LFS, then run `git lfs pull` after cloning to obtain the actual files.

| Platform | Files |
| --- | --- |
| Mac Intel | `EDCONNECTION Classroom-0.1.0-mac-x64.dmg` and `.zip` |
| Mac Apple Silicon | `EDCONNECTION Classroom-0.1.0-mac-arm64.dmg` and `.zip` |
| Windows, both architectures | `EDCONNECTION Classroom-0.1.0-win.exe` |
| Windows x64 only | `EDCONNECTION Classroom-0.1.0-win-x64.exe` |
| Windows ARM64 only | `EDCONNECTION Classroom-0.1.0-win-arm64.exe` |

These are unsigned development installers configured for the existing local backend at `http://127.0.0.1:3000` and website at `http://localhost:4200`. They do not contain or start the backend. They need the backend changes from this commit. Production distribution requires rebuilding with the institution URLs and signing/notarization credentials; see the parent desktop README for commands.

`SHA256SUMS` and `manifest.json` identify the exact installer bytes. From this directory, verify with `shasum -a 256 -c SHA256SUMS` on Mac or `Get-FileHash -Algorithm SHA256 'filename.exe'` on Windows. The blockmaps are matching update sidecars; no hosted update feed is configured.

The classroom supports its shared drawing board and screen/window capture of a device whiteboard. Student device sharing requires teacher approval. Automated tests cover permissions, source switching, reconnect cleanup and recording composition. These newly rebuilt installers were inspected without launching the app. Physical whiteboard hardware, Windows runtime, and Apple Silicon runtime have not been tested on this machine.
