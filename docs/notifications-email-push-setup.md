# Email And Push Notification Setup

Updated: 2026-06-25

This document tracks the reusable notification foundation for the Native SFU platform.

The goal is to support backend-driven notifications for many product areas without each feature building its own email or push implementation.

Initial providers:

- SMTP email through `nodemailer`
- Browser push notifications through Web Push/VAPID

Future providers can be added behind the same service boundary.

## Product Goals

- Send transactional email from the backend.
- Send browser push notifications to opted-in users.
- Reuse the same backend service for class sessions, chat, recordings, enrollments, security notices, and admin operations.
- Respect user notification preferences where applicable.
- Keep provider failures isolated so non-critical notifications do not break product flows.
- Keep SMTP/VAPID secrets outside source control.

## Status Labels

- **Done**: implemented and verified enough to close.
- **Pending**: not implemented yet.
- **Pending Proof**: implemented or partially implemented, but still needs runtime/test evidence.
- **Blocked**: cannot proceed without credentials, infrastructure, or product decision.

## Backend Scope

Status: **Pending**.

Create a shared backend module:

- `NotificationsModule`
- `NotificationsService`
- `EmailService`
- `PushNotificationService`
- `PushSubscriptionsController`
- notification DTOs and provider result types

Recommended path:

- `apps/backend/src/notifications/`

Backend responsibilities:

- Load SMTP and Web Push config through existing `ConfigService`.
- Validate provider config through existing env validation.
- Persist push subscriptions per user.
- Expose authenticated push subscription endpoints.
- Provide reusable send methods for other backend modules.
- Log delivery failures without leaking secrets.
- Return structured delivery results for audit/debugging.

## Frontend Scope

Status: **Pending**.

Frontend portals should support browser push registration only after backend infrastructure exists.

Teacher/student portal responsibilities:

- Request notification permission only after a user action.
- Fetch VAPID public key from backend.
- Register the browser push subscription with backend.
- Allow users to enable/disable push from profile/settings.
- Respect existing profile notification preferences.
- Handle unsupported browsers cleanly.

Admin portal responsibilities:

- No push subscription UI is required initially unless admins need operational alerts.
- Admin user/profile settings can expose notification preferences later if product requires it.

Recommended frontend paths:

- `apps/frontend/src/app/core/services/notification.service.ts`
- `apps/frontend/src/app/features/profile/`
- `apps/admin-portal/src/app/core/services/` only if admin push is added later

## Environment Variables

Status: **Pending**.

Add these variables to `.env`, `.env.example`, backend config, and validation.

SMTP email:

```env
SMTP_ENABLED=false
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM_EMAIL=no-reply@example.com
SMTP_FROM_NAME=Native SFU
SMTP_REPLY_TO=
SMTP_CONNECTION_TIMEOUT_MS=10000
SMTP_GREETING_TIMEOUT_MS=10000
SMTP_SOCKET_TIMEOUT_MS=15000
```

Browser push:

```env
PUSH_ENABLED=false
PUSH_VAPID_PUBLIC_KEY=
PUSH_VAPID_PRIVATE_KEY=
PUSH_VAPID_SUBJECT=mailto:ops@example.com
PUSH_TTL_SECONDS=3600
```

Validation rules:

- Email and push are optional in development.
- Email and push are optional in production unless explicitly enabled.
- If `SMTP_ENABLED=true`, require host, port, from email, and any required auth fields.
- If `PUSH_ENABLED=true`, require VAPID public key, private key, and subject.
- Never log SMTP password or VAPID private key.

## Backend Data Model

Status: **Pending**.

Add a push subscription collection.

Suggested fields:

- `subscriptionId`
- `userId`
- `endpoint`
- `p256dh`
- `auth`
- `userAgent`
- `deviceLabel`
- `createdAt`
- `updatedAt`
- `lastUsedAt`
- `revokedAt`
- `deletedAt`

Indexes:

- unique active endpoint
- `userId + deletedAt + createdAt`
- `userId + revokedAt + updatedAt`

Do not store plaintext secrets beyond the browser-provided push keys required by Web Push.

## Backend API

Status: **Pending**.

Authenticated user endpoints:

- `GET /api/v1/notifications/push/public-key`
- `GET /api/v1/notifications/push/subscriptions`
- `POST /api/v1/notifications/push/subscriptions`
- `DELETE /api/v1/notifications/push/subscriptions/:subscriptionId`

Rules:

- User can only create/list/delete their own subscriptions.
- Public key endpoint may return disabled state if push is off.
- Deleting should revoke/soft-delete instead of hard deleting where possible.
- Expired push endpoints should be revoked automatically after provider failure codes such as 404 or 410.

## Reusable Backend Service Contract

Status: **Pending**.

Recommended high-level methods:

```ts
sendEmail(request)
sendTemplateEmail(request)
sendPush(request)
sendToUser(userId, notification)
sendToUsers(userIds, notification)
```

Recommended notification purposes:

- `class_reminder`
- `class_started`
- `chat_message`
- `announcement`
- `recording_ready`
- `material_shared`
- `enrollment_update`
- `security_notice`
- `admin_alert`

Each send result should include:

- provider
- attempted count
- delivered count
- failed count
- skipped count
- failure reasons without secrets

## Preference Handling

Status: **Pending**.

Reuse existing profile notification settings where possible.

Existing preference areas to map:

- email enabled
- class reminders
- chat messages
- announcements
- recording ready
- teacher live class notification settings

Rules:

- Security notices may bypass marketing-style preference checks if product policy requires it.
- Chat/class/material notifications should respect user preferences.
- The backend should make the final preference decision, not the frontend.

## Feature Integration Targets

Status: **Pending**.

Initial backend integrations should be small and opt-in:

- class reminder email/push
- teacher started class push
- private chat message push
- teacher broadcast announcement email/push
- recording ready email/push
- material shared push
- enrollment update email
- password reset and email verification if not already handled separately

Do not wire every feature at once. First build the reusable infrastructure, then integrate one or two low-risk flows.

## Frontend Registration Flow

Status: **Pending**.

Recommended flow:

1. User opens Profile or Settings.
2. UI shows notification preference controls.
3. User clicks Enable browser notifications.
4. Frontend checks browser support.
5. Frontend requests permission.
6. Frontend registers service worker if needed.
7. Frontend fetches VAPID public key.
8. Frontend creates push subscription.
9. Frontend posts subscription to backend.
10. Backend stores subscription for the authenticated user.

Important UX rules:

- Do not request browser permission on page load.
- Explain why notifications are useful before requesting permission.
- Show unsupported, denied, enabled, disabled, and error states.
- Allow disabling push for the current device.

## Testing Checklist

Status: **Pending**.

Backend tests:

- SMTP disabled path skips cleanly.
- SMTP enabled path validates required config.
- Email service sends expected payload through nodemailer.
- Email failures return structured provider errors.
- Push disabled path skips cleanly.
- Push public key endpoint returns enabled/disabled state.
- Authenticated user can register push subscription.
- User cannot delete another user subscription.
- Push send removes/revokes expired subscriptions on 404/410.
- Unified notification service respects preferences.
- Env validation does not leak secrets.

Frontend tests:

- settings page handles unsupported push browser.
- settings page handles denied permission.
- settings page registers subscription after user action.
- settings page can disable current-device subscription.
- profile notification preferences persist after refresh.

Manual verification:

- SMTP test email reaches a real inbox in staging.
- Push notification reaches Chrome.
- Push notification reaches Android Chrome if in scope.
- iOS Safari behavior is documented separately because Web Push support depends on installation/PWA behavior.

## Production Proof Checklist

Status: **Pending**.

Before production:

- SMTP credentials are stored in secret manager or deployment secrets.
- VAPID private key is stored in secret manager or deployment secrets.
- Staging SMTP send is verified.
- Staging push send is verified.
- Bounce/failure behavior is observable.
- Provider errors are logged without secrets.
- Notification endpoints are rate-limited or protected by existing auth/rate-limit controls.
- User preferences are honored.
- Unsubscribed/revoked devices stop receiving push.

## Rollout Plan

### Phase 1: Infrastructure

- Add backend config/env validation.
- Add SMTP email service.
- Add Web Push service.
- Add push subscription schema and API.
- Add tests.

### Phase 2: Frontend Settings

- Add notification settings UI.
- Add push permission/register/unregister flow.
- Persist profile preferences.

### Phase 3: First Product Integrations

- Recording ready notification.
- Class started notification.
- Private chat message notification.

### Phase 4: Production Hardening

- Add staging proof.
- Add observability counters/logs.
- Add operator runbook entries.
- Confirm provider credentials and rotation policy.

