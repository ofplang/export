/**
 * Fold the Pages build into one ES module, `dist-cdn/ofp-view.js` — the
 * viewer as a thin HTML file loads it (design.md D68).
 *
 * Runs after `vite build`. A thin page is the documents and one script tag:
 *
 *   <script type="application/json" id="ofp-documents" data-contract="1">…</script>
 *   <script type="module" src="https://cdn.jsdelivr.net/npm/@ofplang/export-viewer@<version>/ofp-view.js"></script>
 *
 * so the module brings everything else with it: the stylesheet, the page's
 * markup and the icon, put into the document before the viewer starts. It is
 * published to npm as @ofplang/export-viewer by the release workflow (package
 * source in web/npm/) and served by jsDelivr from /npm/ (design.md D69).
 * An artifact on claude.ai is one such page: Claude writes the documents, not
 * the 210 KB of viewer.
 */

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const DIST = here("../dist/");
const OUT = here("../dist-cdn/");

const html = readFileSync(`${DIST}index.html`, "utf8");
const pick = (pattern, what) => {
  const m = pattern.exec(html);
  if (!m) throw new Error(`build-cdn: no ${what} in dist/index.html`);
  return m;
};

const js = readFileSync(`${DIST}${pick(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/, "script")[1]}`, "utf8");
const css = readFileSync(`${DIST}${pick(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/, "stylesheet")[1]}`, "utf8");

// The page's own markup: everything in <body> but the script that loads the app.
const body = pick(/<body>([\s\S]*?)<\/body>/, "body")[1]
  .replace(/\s*<script type="module"[^>]*><\/script>\s*/, "\n")
  .trim();

// What <head> carries besides the script and stylesheet: the SVG icon and the
// web fonts. The PNG icon sits beside the site and is left out, as in the
// single file; a blocked font falls back to the system faces.
const head = [
  pick(/<link rel="icon" type="image\/svg\+xml"[^>]*>/, "SVG icon")[0],
  ...html.match(/<link rel="preconnect"[^>]*>/g) ?? [],
  pick(/<link\s+rel="stylesheet"\s+href="https:\/\/fonts\.googleapis\.com[^"]*"\s*\/?>/, "font stylesheet")[0],
].join("\n");

let build = process.env["GITHUB_SHA"]?.slice(0, 7);
try {
  build ??= execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
} catch {
  build ??= "unknown";
}

// Set up the page before the app's own code runs: it looks its elements up by
// id as it starts. A block, so these names cannot meet the bundle's own.
const prelude = `{
  const style = document.createElement("style");
  style.textContent = ${JSON.stringify(css)};
  document.head.append(style);
  document.head.insertAdjacentHTML("beforeend", ${JSON.stringify(head)});
  const meta = document.createElement("meta");
  meta.name = "ofp-viewer-build";
  meta.content = ${JSON.stringify(build)};
  document.head.append(meta);
  // Before whatever the page already holds, so #ofp-documents stays where it is.
  document.body.insertAdjacentHTML("afterbegin", ${JSON.stringify(body)});
}
`;

const banner = `/* OFP View ${build} — the viewer for a thin page (design.md D68). https://github.com/ofplang/export */\n`;
const module = banner + prelude + js;

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}ofp-view.js`, module);
console.log(`build-cdn: dist-cdn/ofp-view.js (${Math.round(module.length / 1024)} KB, build ${build})`);
