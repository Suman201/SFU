# Tutor onboarding setup and launch checks

There is no production environment for this task. The implementation can be tested locally; production and real-participant sign-offs remain open.

## Local setup

Use Node 22 and the repository database/Redis configuration. Run:

```sh
npm run setup:tutor-verification
npm run seed:teaching-catalog
```

The setup command creates a random 32-byte encryption key in the ignored `.local-secrets/` directory with owner-only permissions and configures the local `.env` to read it. Re-running the command preserves the existing key. Never commit the key. A key change does not migrate existing ciphertext: preserve the original key with a separate secure backup.

Document validation needs FFmpeg and Poppler's `pdfinfo`. The backend image includes both. Run the key setup before starting development Compose; it mounts the ignored key file as a Docker secret, shared by both nodes in multi-node mode. On a local host, install them or set `TUTOR_PDFINFO_PATH` to the existing executable. Files are checked for type, parse/decode validity and size; this is not a malware scanner or an identity verification provider.

Set `TUTOR_VERIFICATION_RETENTION_DAYS` to the organisation's chosen file retention period (default 30). Uploaded files are encrypted with AES-256-GCM, bound to the owner and document ID, stored privately, and never served as public profile media. Expired files cannot be downloaded and are removed by the retention worker. A verified outcome can remain after its source file expires; deliberate teacher removal withdraws the evidence and requires a new profile review.

## Notifications

Each submission and decision writes an in-app notice and email queue item in the same account update as the status transition. Mail failures are retried with backoff and a delivery lease shared across API processes. Email preferences are honoured; in-app notices remain available. Configure SMTP using the existing `SMTP_*` variables. Email contains status and a link to the profile, not verification files, identity numbers or reviewer findings.

The queue makes at-least-once delivery attempts; a provider accepting a message immediately before a process crash can result in a duplicate retry. Inspect exhausted retries in the onboarding readiness report. SMTP verification checks connectivity; a real delivery to an authorised QA recipient must still be recorded before launch.

## Expert content approval

The starter catalogue contains draft guidance and review criteria. It is never automatically signed off as expert-reviewed. In Admin → Subjects & categories, inspect the category and academic-level instructions, rubrics and any overrides. A qualified reviewer records expertise, findings and explicit confirmation for the current content version. Changed content needs a new sign-off. Tutors can draft their profile while content is pending; submission/approval requires approved applicable tasks. Other subjects use manual suitability review.

## Technical readiness

Admins can use Check onboarding readiness in the catalogue or run:

```sh
TUTOR_READINESS_ADMIN_TOKEN='<admin-access-token>' npm run verify:tutor-onboarding -- --base-url http://127.0.0.1:3000 --output /private/path/onboarding-readiness.json
```

Prefer `--token-file /private/path/admin-token` rather than placing a token in shell history. Do not commit tokens or reports containing participant data. Exit 0 means the technical checks passed; exit 2 means setup or content approvals need attention; exit 1 means the check could not run. The endpoint performs short-lived private storage probes and removes them, verifies SMTP transport, checks validators and reports content approval coverage and exhausted mail retries. It does not send a message or assert that a production launch/pilot has happened.

## Production provisioning

When an environment exists, provision an encryption key through a secret store (`TUTOR_VERIFICATION_ENCRYPTION_KEY_FILE` is supported). The production Compose file expects that secret. Kubernetes secret and external-secret examples include the corresponding key; replace the placeholder with a real secret before deployment. Use shared persistent verification and intro-video storage on every API replica; multi-node Compose mounts dedicated shared volumes. Keep verification storage separate from any public/static path and verify that a file uploaded on one API process can be read through another.

Allow the existing 50 MB video upload, 10 MB verification upload and 1 MB profile/review JSON envelope through the reverse proxy. Configure encrypted backups and keep the verification encryption key outside the data backup. The backup/restore scripts include private verification and separate intro-video volumes. Perform a restore drill into an isolated environment and verify that the original key can decrypt a sample authorised document before admitting users. Do not restore over a live database with active writers.

Run the readiness check against each API replica, execute the teacher/student acceptance flow, and complete [the pilot worksheet](tutor-onboarding-pilot.md). Record actual email delivery, qualified content approval, reviewer evidence checks, participant observations, backup/restore proof and the final deployment sign-off. These steps cannot be inferred from a local synthetic test.
