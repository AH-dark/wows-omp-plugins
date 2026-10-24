/**
 * Render the README banners in `.github/banners/` to `<name>-light.png` and `<name>-dark.png`
 * (1280x400 at 2x) with headless Chrome.
 *
 *   bun run banners                  every `.github/banners/*.html`
 *   bun run banners root audit-goal  only the named banners
 *
 * Chrome is taken from `CHROME_PATH`, then the macOS app bundle, then `google-chrome` or `chromium` on PATH.
 */
import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { REPO_ROOT } from "@/catalog.ts";

const BANNERS_DIR = path.join(REPO_ROOT, ".github", "banners");
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const THEMES = ["light", "dark"] as const;
const CONCURRENCY = 4;

function findChrome(): string {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`CHROME_PATH points at a missing file: ${fromEnv}`);
    return fromEnv;
  }
  if (existsSync(MAC_CHROME)) return MAC_CHROME;
  const onPath = Bun.which("google-chrome") ?? Bun.which("chromium");
  if (onPath) return onPath;
  throw new Error("Chrome not found: set CHROME_PATH, or install Google Chrome or Chromium (google-chrome / chromium on PATH).");
}

async function render(chrome: string, name: string, theme: (typeof THEMES)[number]): Promise<void> {
  const html = path.join(BANNERS_DIR, `${name}.html`);
  const png = path.join(BANNERS_DIR, `${name}-${theme}.png`);
  await rm(png, { force: true });
  const proc = Bun.spawn(
    [
      chrome,
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      "--window-size=1280,400",
      `--screenshot=${png}`,
      `file://${html}?theme=${theme}`,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  const written = await stat(png).catch(() => undefined);
  if (code !== 0 || !written) throw new Error(`Rendering ${name} (${theme}) failed with exit code ${code}:\n${stderr}`);
  console.log(path.relative(REPO_ROOT, png));
}

const available = (await readdir(BANNERS_DIR)).filter((file) => file.endsWith(".html")).map((file) => file.slice(0, -".html".length));
const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !available.includes(name));
if (unknown.length > 0) {
  console.error(`Unknown banner(s): ${unknown.join(", ")}. Available: ${available.join(", ")}`);
  process.exit(1);
}

const chrome = findChrome();
const jobs = (requested.length > 0 ? requested : available).flatMap((name) => THEMES.map((theme) => ({ name, theme })));
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    for (let job = jobs[next++]; job; job = jobs[next++]) await render(chrome, job.name, job.theme);
  }),
);
