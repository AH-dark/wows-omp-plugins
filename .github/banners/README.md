# README banners

Each `<name>.html` here is a 1280x400 banner built on the shared system in
[`banner.css`](banner.css). `bun run banners` renders every page to
`<name>-light.png` and `<name>-dark.png` (2560x800); `bun run banners <name>...`
renders only the named ones. Commit the PNGs with the HTML.

## Requirements

- Google Chrome or Chromium. Set `CHROME_PATH` if it is not at the macOS default
  location or on `PATH` as `google-chrome` / `chromium`.
- Locally installed fonts: Inter Display (with Inter as fallback) and
  JetBrains Mono. The pages load no web fonts, so a machine without them
  renders with system fallbacks and the layout drifts.

## Adding a plugin banner

1. Copy `audit-goal.html` to `<plugin>.html`.
2. Set `data-banner="<plugin>"` on `<html>`. Its light and dark accents come
   from the accent table at the top of `banner.css`.
3. Update the meta row index (`NN / 08`), the title, the tagline and the footer.
4. Draw the diagram inside `.fig` as an inline SVG (`viewBox="0 0 484 196"`)
   using the `d-*` primitive classes, so both themes apply automatically.
5. Run `bun run banners <plugin>` and check both PNGs.
6. Put the banner above the title of `plugins/<plugin>/README.md` and
   `README.zh.md` with the same `<picture>` block the other plugin READMEs
   use. Plugin READMEs link the PNGs by absolute `raw.githubusercontent.com`
   URL because `.github/` does not ship with the installed plugin.
7. A new plugin also needs a banner accent in `banner.css` and the `/ 08`
   totals and root index updated.
