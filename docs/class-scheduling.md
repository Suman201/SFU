# Class scheduling and communication

The website and Windows/macOS app share one Angular calendar component backed by the existing batches, schedules, enrollments and class sessions. The view uses the free MIT `@wts-calendar/core@1.1.6` and `@wts-calendar/angular@1.0.1`. Only month, week and list modules are imported; there is no Premium module, paid license dependency or API key requirement for the calendar UI.

## Teacher and student flows

Teachers open **Calendar** to browse months, jump to a month, switch to week view, select a class, reschedule one occurrence or cancel it. A message to enrolled students is optional. Classes cannot be changed after they start or end. Stale edits and overlapping teacher classes are rejected by the backend. Individual overrides are preserved when the weekly batch timetable changes.

Students use **Explore classes** on the website or **Explore batches** in the classroom app. Enrollment checks batch status, end date, duplicate enrollment and available places. A database lease serializes self-enrollment across backend instances to protect the last place. An active enrollment adds the batch timetable to the student's calendar. The teacher opens the classroom manually; students can join only while their enrollment and session permissions allow it. Leaving a batch removes future calendar access and classroom access.

The existing static booking/payment preview stays separate. It does not charge money, enroll a student or issue an invoice. Gateway integration is still needed to make paid enrollment depend on verified payment.

## Timezones and migration

New teacher batches save the teacher's browser IANA timezone. Admin-created batches use the teacher's saved timezone or UTC. Recurring sessions keep their local clock time across daylight-saving changes. Existing session IDs remain based on the batch's calendar date. A recurring time inside the spring DST gap moves to the first valid clock minute; an autumn repeated time uses the earlier occurrence. Individual rescheduling rejects missing clock times and requires the user to choose the intended occurrence when the time repeats.

The calendar detects the device timezone and lets the user save another IANA timezone. Class times are rendered locally. The saved profile timezone is used for new notifications; otherwise the batch timezone is explicitly included in the message.

**Before starting the new backend against an existing database**, pin missing batch timezones to the timezone the old server used:

```sh
MONGODB_URI=mongodb://127.0.0.1:27018/native_sfu npm run setup:scheduling -- --legacy-timezone Asia/Kolkata
```

Use the actual original timezone; the example is not a universal migration value. The script refuses to guess, only fills missing values, preserves existing UTC class instants, and creates worker indexes. `LEGACY_SCHEDULE_TIMEZONE` is the temporary fallback for unpinned batches; it defaults to UTC. Production disables automatic index creation, so run this setup before deployment. No historical notifications are backfilled.

## Notifications

New enrollment and schedule changes append durable events in the same database write as the change. A worker creates per-recipient in-app notices and email jobs with deterministic unique IDs. Separate backend nodes share leases. SMTP failures retry up to six times with exponential backoff. The inbox stays available even when email is disabled by user preference or SMTP is unavailable.

Class reminders are scheduled for 24 hours and one hour before class. Enrollment must predate the reminder time. A 15-minute catch-up window prevents old reminders arriving after a long outage. Before sending, the worker rechecks the class time/status, batch availability, enrollment, recipient status and reminder preference. Moved/cancelled classes and withdrawn students cannot receive stale reminder mail. Direct classroom links still use the existing backend authorization checks.

`CLASS_NOTIFICATION_POLL_MS` defaults to 30000. Use 500 only for isolated acceptance tests. Email requires the existing SMTP configuration. As with ordinary SMTP queues, delivery is at least once: a process failure after SMTP acceptance but before the database acknowledgment can cause a retry.

## Optional teacher Google Calendar connection

Sapiovian's backend copies upcoming classes into a separate **Sapiovian classes** Google calendar. It refreshes every minute, maintains a rolling 60-day horizon and propagates class moves/cancellations. Stable event IDs avoid duplication on retries. Class changes remain authoritative in Sapiovian. It does not import personal Google events or modify students' calendars.

This uses Google's official `google-auth-library` with offline OAuth, PKCE and five-minute, single-use hashed state. Identity verification distinguishes reconnection to the same account from switching accounts. Credentials and PKCE verifiers are AES-256-GCM encrypted in MongoDB; no Google access/refresh token or client secret is returned to the frontend. Google authorization opens in the external system browser for the desktop app. Teachers can disconnect; previous copied events remain in Google. No external account is connected automatically.

The Google connection is inactive until these backend-only settings are supplied:

- `GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET` for a Google **Web application** OAuth client.
- `GOOGLE_CALENDAR_REDIRECT_URI`, exactly matching the authorized Google redirect, e.g. `http://localhost:3000/api/v1/calendar/google/callback` for local development. Use the public HTTPS backend origin for deployment.
- `GOOGLE_CALENDAR_ENCRYPTION_KEY`: 32 cryptographically random bytes encoded as 64 hex characters. Keep it stable and private; losing it prevents decrypting existing connections.

Enable the Calendar API and configure the consent screen. Requested scopes are `calendar.app.created` and `openid`; they allow managing app-created secondary calendars and identifying the connected account. A public Google API key cannot provide offline access to a teacher's private calendar. Production Google consent/verification requirements apply to the configured project. See [Google OAuth for web servers](https://developers.google.com/identity/protocols/oauth2/web-server) and [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).

## Verification

`tests/browser/calendar-acceptance.spec.ts` uses real NestJS processes on two nodes, isolated MongoDB/Redis, real authentication and a local SMTP sink. It covers batch enrollment and capacity races, scoped calendar data, teacher/student permissions, timezone changes, rescheduling, cancellations, retry delivery, stale reminders, joining and leaving classes, and headless web/desktop routes. No backend HTTP responses are mocked.

The Google-specific tests are provider contract/security tests with simulated Google responses. Live Google consent, token refresh and actual account writes have not been verified without operator credentials and a consenting test account. Headless screenshots are captured from the actual Angular screens. No Electron or visible development app is launched.
