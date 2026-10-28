# Sapiovian Classroom installers

The installers and matching blockmaps are stored in Git LFS. Run `git lfs pull` after cloning to obtain the actual files.

| Platform | Files |
| --- | --- |
| Mac Intel | `Sapiovian Classroom-0.1.0-mac-x64.dmg` and `.zip` |
| Mac Apple Silicon | `Sapiovian Classroom-0.1.0-mac-arm64.dmg` and `.zip` |
| Windows, both architectures | `Sapiovian Classroom-0.1.0-win.exe` |
| Windows x64 only | `Sapiovian Classroom-0.1.0-win-x64.exe` |
| Windows ARM64 only | `Sapiovian Classroom-0.1.0-win-arm64.exe` |

These are unsigned development installers for the local backend at `http://127.0.0.1:3000` and website at `http://localhost:4200`. They do not contain or start the backend. Run the backend from this source snapshot. Production distribution requires rebuilding with institution URLs and signing/notarization credentials; see [desktop build instructions](../README.md).

All four packaged app architectures contain the same verified frontend bytes. The shared website/app now includes the free WTS month/week calendar, mobile agenda, timezone settings, class notifications, teacher rescheduling/cancellation and student batch discovery/enrollment. Google Calendar connection is optional and disabled until backend OAuth credentials are configured; a live Google account has not been tested. See [class scheduling](../../../docs/class-scheduling.md).

The existing classroom, device settings, shared whiteboard and permission-based device whiteboard sharing remain included. No installer or development app was launched during this rebuild. Windows runtime, Apple Silicon runtime and physical whiteboard hardware still need device testing.

`SHA256SUMS` and `manifest.json` identify the exact installer bytes and source digest. Verify with `shasum -a 256 -c SHA256SUMS` on Mac or `Get-FileHash -Algorithm SHA256 'filename.exe'` on Windows. No hosted update feed is configured.
