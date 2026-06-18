# Agent Notes

## Frontend Color Theme

- Use the Native SFU product palette as the default frontend color direction: rose `#F26076`, coral `#FF9760`, amber `#FFD150`, and green `#458B73`.
- Treat green `#458B73` as the calm product base, rose `#F26076` as the primary action/accent color, coral `#FF9760` as the live/highlight color, and amber `#FFD150` as the attention/status color.
- Frontend UI should feel premium, compact, and product-like in both light and dark mode; avoid one-note palettes, oversized decorative blobs/orbs, and generic gradient-only sections.
- Prefer existing theme variables and add page-local aliases only when a feature needs the product palette without disturbing unrelated surfaces.

## Frontend Table UI

- All frontend data tables should use the shared admin table pattern from `apps/frontend/src/styles.scss`.
- Prefer the `data-table-shell`, `data-table-toolbar`, `data-table-filters`, `data-table-wrap`, `data-table`, `data-pill`, `table-action`, and `table-avatar` classes instead of page-specific table styling.
- Tables should match the clean workspace style: compact toolbar with view/actions, filter chips above the grid, light row and column dividers, small status pills, compact action buttons, checkbox selection column when useful, and footer row counts for longer lists.
- For rows with several secondary actions, prefer a compact three-dot row menu using `table-menu-button`, `row-menu-cell`, and `table-row-menu`.
