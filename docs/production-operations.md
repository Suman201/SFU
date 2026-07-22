# Production Operations

This guide describes the production controls implemented in the repository and the environment proof still required before serving paid traffic.

## Readiness Boundary

Implemented in the repository:

- production environment validation and secret-file loading
- Redis-backed HTTP and per-connection Socket.IO rate limits
- hard room, participant, producer, consumer, screen-share, and bitrate ceilings
- bounded media packet/pacing queues
- media-worker health, restart, drain, and failed-room handling
- Redis-backed room ownership and encrypted cross-node UDP pipes
- graceful node drain during Kubernetes termination and scale-up-only HPA policy
- HTTPS ingress and Coturn TLS certificate templates
- Prometheus alerts, Alertmanager delivery, and Grafana provisioning
- authenticated MongoDB/Redis production Compose profile
- non-root, read-only backend container runtime
- MongoDB and local-artifact backup/restore scripts

Still requires target-environment proof:

- public host candidate and TURN reachability
- real secret-manager values and rotation approvals
- measured room/worker capacity limits
- alert receiver delivery
- backup restore drill and measured RPO/RTO
- staged multi-node reconnect, pipe, drain, and privacy behavior

## Reference Topology

The Kubernetes profile assumes:

- one stable StatefulSet backend media pod per node using `hostNetwork`
- full `HOST_CANDIDATE_PORT_RANGE` and `PIPE_PORT_RANGE` allowed between required networks
- encrypted pipe mode enabled behind one shared signaling ingress
- at least two dedicated public Coturn hosts with UDP 3478, TCP 3478, TLS 5349, and relay ports 49160-49259
- externally managed MongoDB and Redis
- a ReadWriteMany filesystem for recordings and server-stored attachments/materials/profile media
- cert-manager and an existing `letsencrypt-prod` ClusterIssuer
- External Secrets Operator and an existing `production-secret-store`, or an equivalent private Secret workflow

Do not put RTP/RTCP media through the HTTP ingress. Do not scale host-network backend replicas beyond the number of eligible nodes.

## Required Network Paths

| Path | Protocol | Default ports | Exposure |
| --- | --- | --- | --- |
| Web/API/Socket.IO | HTTPS/WSS | 443 | Public through ingress |
| SFU host candidates | UDP | 40000-40999 | Public client to backend node |
| Encrypted SFU pipes | UDP | 41000-41100 | Backend node to backend node |
| TURN | UDP/TCP | 3478 | Public client to Coturn |
| TURN TLS | TLS/TCP | 5349 | Public client to Coturn |
| TURN relays | UDP/TCP | 49160-49259 | Public relay traffic |
| MongoDB/Redis | TCP | Provider-specific | Private backend network only |

`ICE_ANNOUNCED_ADDRESS` and the Coturn external address must be addresses a browser can reach. The Kubernetes manifests derive them from `status.hostIP`; replace those overrides when node host IPs are private or use non-1:1 NAT. Publish both Coturn node addresses for `turn.sfu.example.com` or place a validated UDP/TCP load balancer in front of them.

## Secrets

Application secrets accept either `KEY=value` or `KEY_FILE=/path/to/secret`; direct values take precedence. Production Compose uses Docker secret files. Kubernetes uses `native-sfu-secrets`, with `external-secret.example.yaml` as a provider-neutral mapping example.

At minimum protect:

- MongoDB and Redis URLs/passwords
- JWT access and refresh secrets
- operations token
- TURN shared secret
- webhook encryption key
- pipe cluster secret
- optional S3, SMTP, VAPID, and ingest credentials

Never store real values in `.env`, Compose YAML, Kubernetes ConfigMaps, container images, or Git.

### Pipe Secret Rotation

1. Set `PIPE_CLUSTER_SECRET_PREVIOUS` to the current secret on every node.
2. Roll `PIPE_CLUSTER_SECRET` to the new secret while retaining the previous value.
3. Wait until all old nodes and in-flight coordination messages have expired.
4. Clear `PIPE_CLUSTER_SECRET_PREVIOUS` in a second rollout.

Nodes sign new commands with the current key and accept the current or previous key during the overlap.

### JWT And Operations Token Rotation

JWT secrets are not dual-key today. Rotate them during an announced maintenance window and expect existing access/refresh tokens to be invalidated. Rotate the operations token in Prometheus, deployment secrets, and operator clients as one coordinated change.

### TURN Rotation

TURN credentials returned to browsers are short-lived. Roll the shared secret in the backend and Coturn together, retaining the old Coturn deployment long enough for the maximum credential lifetime when uninterrupted sessions matter.

## Capacity And Abuse Controls

The following are hard rejection limits, not sizing recommendations. HTTP throttling is atomic across replicas through Redis; Socket.IO buckets are enforced per connection/node so high-frequency cursor events do not add a Redis round trip:

- `ROOM_MAX_PARTICIPANTS`
- `ROOM_MAX_PRODUCERS` and `ROOM_MAX_PRODUCERS_PER_PARTICIPANT`
- `ROOM_MAX_CONSUMERS` and `ROOM_MAX_CONSUMERS_PER_PARTICIPANT`
- `ROOM_MAX_SCREEN_PRODUCERS`
- audio/video/screen bitrate ceilings
- HTTP and per-bucket Socket.IO rate limits
- Socket.IO maximum payload bytes
- media-worker room, transport, request, latency, memory, and packet-rate limits

Tune these from staged measurements. Increasing a limit without increasing UDP ports, CPU, memory, and bandwidth can turn a clean admission rejection into a room-wide outage.

## Metrics And Alerts

Prometheus scrapes `/metrics` with the operations token via a mounted credential file. Grafana provisions the Native SFU dashboards. Alertmanager reads its webhook URL from a Docker secret. Kubernetes clusters with Prometheus Operator can apply `infra/k8s/monitoring.yaml`; adjust its resource-label selectors to match the installed operator release.

The shipped alerts cover:

- backend unavailable
- workers unavailable or restarting
- high worker capacity
- failed rooms
- high RTP drop ratio
- API/socket rate-limit abuse
- hard capacity rejections
- Redis control-plane failures
- pipe errors
- metrics refresh failures
- event-loop lag

Before launch, force one warning and one resolved alert and confirm both reach the real receiver. Restrict Prometheus, Alertmanager, and Grafana to an operator network or authenticated gateway.

Container logs use the bounded Docker `local` driver. Kubernetes deployments should use the platform log collector with retention and access controls. Structured request logs redact authorization, cookies, tokens, passwords, secrets, credentials, client IP fields, and response cookies.

## Rollout And Drain

For planned maintenance:

1. Call `POST /api/v1/media/node/drain` with the operations token.
2. Confirm `/health/ready` fails and diagnostics report `trafficReady=false`.
3. Wait for owned rooms to reach zero, or use an approved forced-maintenance policy.
4. Terminate the pod/process.
5. Confirm ownership, participant presence, producer/consumer counts, and failed-room metrics settle.

The Kubernetes `preStop` hook starts drain and waits five seconds before SIGTERM. The application then waits up to `GRACEFUL_SHUTDOWN_TIMEOUT_MS` for owned rooms. Backend pods are an `OnDelete` StatefulSet so node IDs and scale-down order are stable. HPA scale-down is disabled because active DTLS/SRTP transports cannot migrate between processes.

For scale-down, port-forward to the highest ordinal (for example `backend-3`), drain that pod, confirm it owns zero rooms, then reduce StatefulSet replicas from four to three. For image/config rollout, drain and delete one StatefulSet pod at a time; `OnDelete` prevents Kubernetes from cycling active owners automatically. The backend PDB permits at most one unavailable replica.

## Backup

The baseline command backs up MongoDB plus local recordings, chat attachments, class materials, and profile media:

```bash
MONGODB_URI_FILE=/run/secrets/mongodb_uri \
BACKUP_ROOT=/secure-backups/native-sfu \
BACKUP_RETENTION_DAYS=30 \
BACKUP_AGE_RECIPIENT=age1... \
npm run backup:production
```

The output contains a gzipped Mongo archive, separate artifact archives, a manifest, and SHA-256 checksums. When `BACKUP_AGE_RECIPIENT` is set, the final bundle is encrypted with `age` and the plaintext bundle is removed.

Redis is intentionally excluded. Presence, ownership, rate-limit, and coordination keys are transient; after restore, start Redis clean and let nodes rebuild runtime state. When recording storage uses S3, protect the bucket with versioning, lifecycle retention, encryption, and provider backup independently.

Recommended starting policy:

- nightly full repository backup, retained 30 days
- managed MongoDB point-in-time recovery when the product RPO is under 24 hours
- cross-region or off-account copy for paid-user data
- quarterly isolated restore drill
- target RPO/RTO recorded and approved by the product owner

## Restore

Stop backend writers and restore into an isolated environment first:

```bash
RESTORE_CONFIRMATION=restore-production-data \
BACKUP_BUNDLE=/secure-backups/native-sfu/native-sfu-YYYYMMDDTHHMMSSZ.tar.gz.age \
BACKUP_AGE_IDENTITY_FILE=/run/secrets/backup_age_identity \
MONGODB_URI_FILE=/run/secrets/restore_mongodb_uri \
RECORDING_LOCAL_PATH=/restore/recordings \
CHAT_ATTACHMENT_LOCAL_PATH=/restore/chat-attachments \
CLASS_MATERIAL_LOCAL_PATH=/restore/class-materials \
PROFILE_MEDIA_LOCAL_PATH=/restore/profile-media \
npm run restore:production
```

The restore validates checksums before writing. It does not drop existing MongoDB data unless `RESTORE_DROP_EXISTING=true` is explicitly set. After restore:

1. verify collection counts and representative authorized downloads
2. start a clean Redis instance
3. start one drained backend node and verify health/diagnostics
4. run authenticated API and completed-session artifact smoke checks
5. undrain, then add remaining nodes gradually

Record elapsed restore time, data timestamp, exceptions, and evidence in the incident/change ticket.

## Production Compose

`infra/docker-compose.prod.yml` is a single-backend deployment profile with authenticated MongoDB/Redis, Coturn TLS, Prometheus, Alertmanager, and Grafana. Every `${..._FILE}` must point to a host file readable by Docker. Set public domain/IP values in `.env.production`; do not put secret contents there.

Validate interpolation before rollout:

```bash
docker compose --env-file .env.production -f infra/docker-compose.prod.yml config --quiet
```

## Kubernetes Apply Order

1. namespace and cluster prerequisites
2. external secret/private Secret
3. ConfigMap
4. certificates
5. RWX storage
6. backend and Coturn
7. frontend, HPA, PDBs, and ingress

Replace `sfu.example.com`, `turn.sfu.example.com`, example public IPs, `rwx-file`, issuer name, secret store, image tags, resources, and replica limits. Pin images by immutable digest for release deployments.

## Release Gate

Repository implementation is complete only when the build and focused tests are green. Production approval additionally requires evidence for:

- browser publish/subscribe through public ingress
- direct and relayed media from restrictive networks
- UDP/TCP/TLS TURN allocations
- multi-node joins, reconnects, targeted-event privacy, pipes, and drain
- alert firing and resolution delivery
- backup creation and isolated restore
- measured capacity and accepted safety margins
- rollback and on-call ownership

Track that evidence in [unproven-checklist.md](unproven-checklist.md), without marking implementation work as environment proof.
