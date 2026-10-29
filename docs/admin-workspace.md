# Sapiovian admin workspace

The admin portal uses the existing Angular application, API endpoints, permissions and approved Sapiovian brand assets.

## Interface

- Grouped navigation for teaching, people/curriculum, business and system modules. Module search filters navigation only, so it does not imply a platform-wide data search.
- A collapsible desktop sidebar, persistent local width preference and a mobile drawer with focus trapping, Escape dismissal, focus restoration and background scroll locking.
- A compact top bar, current module context, account identity, theme control and sign-out action.
- A dashboard with four primary metrics, live classes, operational action items, platform totals and working shortcuts. Missing data displays a dash until the backend responds.
- Consistent page headers, compact summaries, readable table rows, quieter status badges, aligned controls, pagination, forms and detail cards throughout management modules.
- Secondary filters are available under **More filters** on the busiest reports; all existing filters still bind to their original controls and API queries.
- A redesigned sign-in page with inline field validation. Session and access redirect notices survive the subsequent guest-guard check.
- Keyboard-safe confirmations with conservative initial focus and the existing confirmation/cancellation behavior.

## Styling structure

`apps/admin-portal/src/styles.scss` defines light/dark semantic colors, text contrast, focus states, loading and brand presentation. `src/styles/_workspace.scss` owns shared workspace typography, density, tables, filters, forms and responsive rules. It uses the existing `data-table-*`, `data-pill`, `table-action` and related table conventions.

Feature-specific layouts live inside the `admin-pages` CSS layer. Shared workspace rules are unlayered so the common design stays consistent without competing page overrides or new `!important` declarations. Repeated page-header, summary, filter and pagination styles have been removed from individual features. Keep a feature's unique layout in its stylesheet; update the shared foundation for common controls.

The shell, dashboard, authentication and public reference pages have their own bounded layouts. The public Error Encyclopedia remains accessible without an admin session. Its incident log remains protected.

The small shared `AdminIcon` component renders the portal's line icons from typed local SVG paths. There is no new icon or UI framework dependency.

## Validation

Build the portal before running browser checks:

```sh
NG_BUILD_MAX_WORKERS=2 npm run build -w @native-sfu/admin-portal -- --configuration production
npm test -w @native-sfu/admin-portal
```

`tests/browser/admin-makeover-acceptance.spec.ts` uses the actual Nest backend, isolated MongoDB and Redis. It signs in through the UI, verifies seeded backend records, navigation search/collapse, user filtering and editing, safe confirmation cancellation, catalogue writes, invoice drafts, management routes, light/dark views, mobile navigation, logout and non-admin access. Screenshots come from the running application. The class records are database fixtures for admin presentation; this test does not establish classroom media performance.

Use a dedicated local MongoDB URL whose database is `whiteboard_acceptance`, an isolated Redis instance and local test JWT/TURN secrets. `ADMIN_MAKEOVER_UI_OUTPUT` controls screenshot output. For example, after setting those environment variables:

```sh
npm run test:browser -- tests/browser/admin-makeover-acceptance.spec.ts \
  --project=chromium --project=firefox --project=webkit \
  --output=/tmp/sapiovian-admin-acceptance
```

The existing `admin-portal-runtime-smoke.spec.ts` supplements this with API fixtures for 19 list/detail routes at desktop, tablet and mobile widths. `error-encyclopedia.spec.ts` checks public code pages and protected-log entry points. These fixture/outage checks are separate from the real-backend acceptance flow.

All checks run headlessly. No native development app or visible browser is required. Deployment uses the existing admin build and environment configuration; no database migration, new service or credential is required for the makeover.


Validated on 29 October 2026: the real-backend acceptance flow passed in Chromium, Firefox and WebKit, including 1440px, 820px and 390px layouts. The existing admin root integration test passed, along with all 12 route/reference regression checks across those browser engines. Headless screenshots include the dashboard, user directory/detail, invoice editor, catalogue, sign-in, dark mode and mobile navigation.

The production build also passed. Its real-backend acceptance flow and all four route/reference regression checks were rerun successfully in Chromium.
