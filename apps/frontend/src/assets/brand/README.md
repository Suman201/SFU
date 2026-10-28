# Sapiovian brand assets

Approved identity: the two complementary forms making an abstract S, the custom
Sapiovian wordmark, and **Your curiosity. Their calling.**

- `sapiovian-logo.png`: original approved transparent master, unchanged.
- `sapiovian-artwork.json`: original dimensions and render viewports.
- `sapiovian-lockup.png`: tightly framed complete logo and tagline.
- `sapiovian-mark.png` / `.svg`: approved symbol, with no lettering.
- `sapiovian-wordmark.png`: original custom lettering, not a replacement font.
- `favicon-32.png`, `favicon.ico`, `apple-touch-icon.png`: browser/home-screen icons.

`BrandLogo` and `BrandMark` are shared by the website and desktop renderer.
Dark mode uses the approved white monochrome treatment. Compact navigation can
omit the tagline; it remains visible on the full website and app login lockups.

Run `npm run icons -w @native-sfu/desktop` from the repository root to export the
web assets and `apps/desktop/resources/icon.{png,svg,ico,icns}`. Export uses headless
Chromium and never opens the app. The SVG files embed the approved raster master;
they are rendering containers, not outlined vector artwork.
