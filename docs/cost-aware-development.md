# Cost-aware development rules

These rules guide changes to Sapiovian's website, Windows/Mac app, backend and deployment. They describe the intended development approach; this document does not mean the proposed behavior is already implemented or validated.

## Classroom experience

- Keep the existing classroom features available. Reduce unnecessary resource use through sensible defaults and automatic behavior.
- Prefer two clear classroom modes: Teaching and Discussion. Reuse shared web/desktop components and the existing teacher permissions.
- In Teaching mode, prioritize the teacher, the selected whiteboard or screen, and audio. Avoid broadcasting every student's camera to every participant by default. Teachers must retain the ability to see the student feeds they need.
- In Discussion mode, allow the additional participant video needed for interaction. Do not impose an audio-only experience on subjects that need visual interaction.
- Use the built-in whiteboard's synchronized operations for writing and drawing. Preserve device-whiteboard and screen-sharing options for the teacher's chosen workflow.
- Prefer automatic video quality. Preserve clear speech and readable text, handwriting and mathematics; adapt camera quality and screen-share frame rate to the content and connection.
- Keep cost optimization out of the normal user journey unless the user needs to make a meaningful choice. Do not introduce a collection of technical switches.

## Media delivery

- Deliver video according to actual visibility, tile size and teaching need. A hidden video element alone is not a bandwidth optimization: pause its unnecessary server-side subscription or select an appropriate lower layer.
- Respect pinned feeds, the teacher's monitoring needs, recording consumers and active screen sharing. Hiding a video tile must not mute its audio or interrupt another consumer.
- Reuse the existing simulcast, SVC, quality-allocation and dynacast capabilities where applicable. Confirm the complete browser-to-SFU behavior instead of relying on configuration flags or estimated savings.
- Resume video correctly after layout changes and reconnects, including keyframes and the required whiteboard state synchronization.
- End unused media delivery and recording when a class ends. Preserve the existing reconnect grace period; a temporary disconnect must not end an active class to save resources.

## Recording and playback

- Prefer one combined classroom recording. Avoid separate participant recordings, duplicate files and repeated conversions unless a specific product requirement needs them.
- Reuse teacher-device recording where supported and reliable. Evaluate its effect on the teacher's CPU and connection before depending on it; retain an appropriate recovery or fallback path.
- Preserve chunk recovery and idempotent uploads. A lower infrastructure cost must not cause lost recordings or broken classroom sessions.
- Make retention explicit and configurable, using the existing settings where possible. A 30- or 90-day policy is a product choice to confirm, not permission to silently expire existing recordings.
- Show expiry information and offer authorized downloads where applicable. Never delete financial records, enrollments or unrelated classroom data as recording cleanup.
- Load recordings on demand. Avoid autoplay previews, full-file prefetches and duplicate downloads that the student did not request.

## STUN and TURN

- Keep authenticated TURN fallback available for restrictive school, office and mobile networks. Prefer direct client-to-SFU connections when possible; the SFU remains part of the classroom media path.
- Reuse the existing Coturn configuration and expiring credential mechanism. Keep shared secrets on the backend, require authorized credential access and apply sensible allocation and bandwidth limits.
- Include UDP, TCP and TLS fallback in deployment validation. Plan TURN-over-TLS on port 443 for restrictive networks, including its interaction with website HTTPS routing.
- Coturn may share the application host for a small deployment after load testing. Include its CPU, memory, relay traffic and shared failure impact in the decision.
- Do not assume TURN always doubles billable traffic. Model the actual network paths, internal routing and provider accounting rules. Do not rely on an unauthenticated public relay.

## Hosting and cost estimates

- Prefer a simple deployment with bundled bandwidth for the initial small workload. Reuse the existing backend; do not add separate paid infrastructure without a demonstrated need.
- A shared host for the backend, MongoDB, Redis and Coturn is a possible pilot configuration, not an availability or capacity guarantee. Keep databases private and backups separate, and verify restoration.
- Build application bundles outside the live classroom host. Keep builds and unnecessary batch processing from competing with live media.
- Size infrastructure by concurrent classes, publishers, subscribers, fanout, bitrate and recording work. Monthly teaching hours alone do not establish required capacity.
- Use this illustrative comparison workload unless another workload is specified: 100 teaching hours per month, 10 students per class, one class at a time, in a European region. State whether student cameras and recordings are included.
- Estimate decimal outbound GB as total delivered Mbps x seconds / 8 / 1000. For example, 2 Mbps delivered to each of 10 students over 100 hours is approximately 900 GB before protocol overhead and other traffic.
- Add uploads, TURN routing, recording creation and playback, backups, storage, email, public IPs and tax as applicable. Distinguish free allowances and temporary credits from ongoing usage costs.
- Recheck official provider prices and plan availability before purchasing. Treat the discussed USD 30-45 monthly budget as a provisional pilot target, not a hard requirement or a promise.
- Lower bandwidth does not automatically lower a fixed bundled bill. State whether an optimization reduces current spending, avoids overage, increases capacity or reduces another resource.

## Evidence before acceptance

- For changes that materially affect media or recording cost, report the workload and measured server CPU, peak memory, transmitted/received bytes, selected video quality, TURN usage and recording size as relevant.
- Validate with the real backend and representative teacher/student sessions. Cover teacher permissions, student access, audio, readable teaching content, whiteboard synchronization, reconnects and recording recovery as affected.
- Use headless testing and provide actual screenshots for UI changes. Do not open the development app or a visible browser unless the user explicitly requests it.
- Label estimates and untested capacity clearly. Do not claim a feature is production-ready or quote a savings percentage based only on theoretical bitrate reductions.

## Reference sources

These are technical and pricing references, not permanently fixed prices:

- [AWS Lightsail pricing](https://aws.amazon.com/lightsail/pricing/)
- [AWS Lightsail data transfer accounting](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-data-transfer-allowance.html)
- [WebRTC encoding parameters](https://www.w3.org/TR/webrtc/)
- [Coturn configuration reference](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)
- [Adaptive SFU subscription example](https://docs.livekit.io/transport/media/subscribe/) — a reference pattern; Sapiovian uses its existing SFU implementation.
