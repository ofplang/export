/**
 * Put documents into a single-file viewer (design.md D48).
 *
 * The contract between the template and anything that fills it — this
 * module, the tests, and the Python CLI (`ofplang/export/template.py`) — is one element:
 *
 *   <script type="application/json" id="ofp-documents" data-contract="1">…</script>
 *
 * whose content is `null` (an empty viewer, to drop files on) or a JSON object
 * `{ name, plan?, workflow?, environment?, ui? }`, each document being the YAML
 * text as written. The page parses the YAML itself, with the same reader it
 * uses for a dropped file, so nothing here interprets a document.
 *
 * `<` is written as `\u003c`: a YAML comment containing `</script>` would
 * otherwise end the element early. The escape is JSON, so the text arrives
 * unchanged.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

export const CONTRACT = "1";

const ELEMENT = /(<script type="application\/json" id="ofp-documents" data-contract="(\d+)">)([\s\S]*?)(<\/script>)/;

/** Serialise the payload for the element's body. */
export function encodeDocuments(docs) {
  return JSON.stringify(docs).replace(/</g, "\\u003c");
}

/** The template with `docs` in it. `docs` is null for an empty viewer. */
export function embed(template, docs) {
  const m = ELEMENT.exec(template);
  if (!m) throw new Error("not a viewer template: no #ofp-documents element");
  if (m[2] !== CONTRACT) throw new Error(`template speaks contract ${m[2]}, this writes ${CONTRACT}`);
  const body = docs === null ? "null" : encodeDocuments(docs);
  // A function replacement, so `$` in a document is not read as a pattern.
  return template.replace(ELEMENT, (_, open, _v, _old, close) => `${open}${body}${close}`);
}

// node scripts/embed.mjs <template> <out> [plan.yaml] [--workflow w.yaml] [--env e.yaml]
// A development convenience; stage D's CLI is the tool people are meant to use.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [template, out, ...rest] = process.argv.slice(2);
  if (!template || !out) {
    console.error("usage: node scripts/embed.mjs <template.html> <out.html> [plan.yaml] [--workflow w.yaml] [--env e.yaml]");
    process.exit(2);
  }
  const docs = { name: "" };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const key = flag === "--workflow" ? "workflow" : flag === "--env" ? "environment" : "plan";
    const path = key === "plan" ? flag : rest[++i];
    docs[key] = readFileSync(path, "utf8");
    if (!docs.name || key === "plan") docs.name = basename(path);
  }
  writeFileSync(out, embed(readFileSync(template, "utf8"), docs.plan || docs.workflow ? docs : null));
  console.log(out);
}
