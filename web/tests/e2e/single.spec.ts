/**
 * The single-file viewer, opened the way people will open it: from disk.
 *
 * `npm run test:e2e` builds `dist-single/viewer.html` first. Each test writes
 * documents into it with the same `embed()` the Python CLI will mirror, then
 * opens the result over `file://` — no server, which is the whole point of
 * the single file (design.md D48).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expect, test, type Page } from "@playwright/test";

// @ts-expect-error — a plain .mjs module, shared with the build scripts
import { embed } from "../../scripts/embed.mjs";

const TEMPLATE = fileURLToPath(new URL("../../dist-single/viewer.html", import.meta.url));
const example = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../external/ofplang-schedule/examples/${rel}`, import.meta.url)), "utf8");

test.beforeAll(() => {
  if (!existsSync(TEMPLATE)) throw new Error("no dist-single/viewer.html — run `npm run build:single` first");
});

/**
 * An interpreter that really runs, with PyYAML, as the path of its executable.
 *
 * On Windows a bare `python` spawned from Node can be the Microsoft Store alias
 * (exit 9009), and a pyenv-win shim is a `.bat` that only a shell can start. So
 * each candidate is asked, through the shell, where its real executable is —
 * and that path is then run directly, with no shell to mangle arguments that
 * contain spaces.
 */
function findPython(): string[] {
  const candidates = [process.env["PYTHON"], "python3", "python", "py -3"].filter(Boolean) as string[];
  for (const cmd of candidates) {
    const probe = spawnSync(`${cmd} -c "import sys, yaml; print(sys.executable)"`, {
      shell: true,
      encoding: "utf8",
    });
    const exe = probe.stdout?.trim();
    if (probe.status === 0 && exe && existsSync(exe)) return [exe];
  }
  throw new Error("no Python with PyYAML found; set PYTHON to one");
}

/** Write a viewer with `docs` in it and open it from disk; count what it fetched. */
async function openWith(page: Page, docs: unknown, file: string): Promise<string[]> {
  writeFileSync(file, (embed as (t: string, d: unknown) => string)(readFileSync(TEMPLATE, "utf8"), docs));
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(pathToFileURL(file).href);
  return requests;
}

test("a plan with its workflow and environment, from disk", async ({ page }, info) => {
  const requests = await openWith(
    page,
    {
      name: "plate_batch.plan.yaml",
      plan: example("outputs/plate_batch.plan.yaml"),
      workflow: example("outputs/plate_batch.workflow.yaml"),
      environment: example("outputs/plate_batch.env.yaml"),
    },
    info.outputPath("plate_batch.html"),
  );

  await expect(page.locator("#plot rect.bar").first()).toBeVisible();
  await expect(page.locator("#graph g.gnode").first()).toBeVisible();
  await expect(page.locator('#layouts [data-layout="split"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#ro-count")).toHaveText("44");
  await expect(page.locator("#dataset option:checked")).toHaveText("plate_batch.plan.yaml");

  // Nothing beside the file is needed: no datasets, no script, no stylesheet.
  // The web fonts are the one thing it may ask for, and it works without them.
  const local = requests.filter((u) => !u.startsWith("https://fonts."));
  expect(local.filter((u) => !u.startsWith("file:") || /datasets|assets/.test(u))).toEqual([]);

  // A link made from a file on someone's disk would point at that disk (D48).
  await expect(page.locator("#share")).toBeHidden();

  // Its tab says which file it is; its icon is inline, with no PNG to look for beside it (D55).
  await expect(page).toHaveTitle("plate_batch.plan.yaml — OFP View");
  await expect(page.locator('link[rel="icon"]')).toHaveCount(1);

  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: fileURLToPath(new URL("../../shots/single.plate_batch.png", import.meta.url)) });
});

test("a workflow alone opens on the workflow alone", async ({ page }, info) => {
  await openWith(
    page,
    { name: "reformatter.workflow.yaml", workflow: example("reformatter.workflow.yaml") },
    info.outputPath("workflow.html"),
  );
  await expect(page.locator("#graph g.gnode")).toHaveCount(9);
  await expect(page.locator("#plan-pane")).toBeHidden();
});

test("text that would end the element early arrives intact", async ({ page }, info) => {
  // A YAML comment is free text; `</script>` in it must not cut the page short.
  const workflow = `${example("reformatter.workflow.yaml")}\n# </script><b>not markup</b> $& $1\n`;
  await openWith(page, { name: "tricky.yaml", workflow }, info.outputPath("tricky.html"));
  await expect(page.locator("#graph g.gnode")).toHaveCount(9);
  await expect(page.locator("b", { hasText: "not markup" })).toHaveCount(0);
});

test("a plan of several jobs is drawn here too, one job at a time on request", async ({ page }, info) => {
  await openWith(
    page,
    { name: "shared_bay.plan.yaml", plan: example("outputs/shared_bay.plan.yaml") },
    info.outputPath("joint.html"),
  );
  await expect(page.locator("#plot rect.bar").first()).toBeVisible();
  const picker = page.locator("#job");
  await expect(picker).toBeVisible();
  await expect(picker.locator("option")).toHaveText(["All jobs (2)", "job1", "job2"]);
  const all = await page.locator("#plot .bar").count();
  await picker.selectOption("job2");
  await expect.poll(() => page.locator("#plot .bar").count()).toBeLessThan(all);
});

test("a file written by the Python command opens on what it was asked for", async ({ page }, info) => {
  // Across the two languages: `ofp-export view` (Python) fills the template the
  // page is built into, and the page honours the opening view it was given.
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const out = info.outputPath("from-python.html");
  const [python, ...lead] = findPython();
  const run = spawnSync(
    python!,
    [
      ...lead,
      "-m", "ofplang.export", "view",
      "external/ofplang-schedule/examples/outputs/plate_batch.plan.yaml",
      "--layout", "plan", "--gantt", "flow",
      "--template", TEMPLATE,
      "-o", out,
    ],
    { cwd: repo, encoding: "utf8" },
  );
  expect(run.status, `${python} said: ${run.stderr || run.error}`).toBe(0);
  const printed = run.stdout.trim();
  expect(printed).toBe(out);

  await page.goto(pathToFileURL(out).href);
  await expect(page.locator("#plot rect.bar").first()).toBeVisible();
  await expect(page.locator("#graph-pane")).toBeHidden();
  await expect(page.locator('#views button[data-view="flow"]')).toHaveAttribute("aria-pressed", "true");
  // The workflow came from the plan's `meta`, so choosing Both shows it.
  await page.locator('#layouts [data-layout="split"]').click();
  await expect(page.locator("#graph g.gnode").first()).toBeVisible();
});

test("an empty viewer asks for a drop, and takes one", async ({ page }, info) => {
  await openWith(page, null, info.outputPath("empty.html"));
  await expect(page.locator("#banner")).toContainText("no documents");

  const dataTransfer = await page.evaluateHandle((text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], "reformatter.workflow.yaml", { type: "text/yaml" }));
    return dt;
  }, example("reformatter.workflow.yaml"));
  await page.dispatchEvent("body", "drop", { dataTransfer });
  await expect(page.locator("#graph g.gnode")).toHaveCount(9);
});

test.describe("the Object view, asked for by the Python command (T2, plan step 5)", () => {
  const write = (out: string, ...args: string[]) => {
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const [python, ...lead] = findPython();
    const run = spawnSync(
      python!,
      [...lead, "-m", "ofplang.export", "view", ...args, "--gantt", "object", "--template", TEMPLATE, "-o", out],
      { cwd: repo, encoding: "utf8" },
    );
    expect(run.status, `${python} said: ${run.stderr || run.error}`).toBe(0);
    return run.stderr;
  };

  test("opens on it, one lane per Object", async ({ page }, info) => {
    const out = info.outputPath("object.html");
    expect(write(out, "external/ofplang-schedule/examples/outputs/storage.plan.yaml")).toBe("");
    await page.goto(pathToFileURL(out).href);
    await expect(page.locator('#views button[data-view="object"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#gutter [data-o]")).toHaveCount(3);
  });

  test("without a workflow, warns, and the page opens on Device with the reason on the button", async ({ page }, info) => {
    const out = info.outputPath("object-no-workflow.html");
    const err = write(out, "external/ofplang-schedule/examples/outputs/storage.plan.yaml", "--no-follow");
    expect(err).toContain("warning: the Object view (`--gantt object`)");

    await page.goto(pathToFileURL(out).href);
    await expect(page.locator("#plot rect.bar").first()).toBeVisible();
    const button = page.locator('#views button[data-view="object"]');
    await expect(page.locator('#views button[data-view="device"]')).toHaveAttribute("aria-pressed", "true");
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await expect(button).toHaveAttribute("title", /no workflow/);
    // Marked unavailable, not disabled, so a click still reaches it — and does
    // nothing. (Playwright will not click an aria-disabled button unforced.)
    await button.click({ force: true });
    await expect(page.locator('#views button[data-view="device"]')).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: info.outputPath("unavailable.png") });
  });
});

test("a workflow with a literal opens, and shows the value with its port", async ({ page }, info) => {
  // Until 0.1.3 a `value` source entry (workflow spec 2.6.6) stopped the whole
  // workflow from being read.
  const workflow = [
    'spec_version: "0.0"',
    "types: { Plate: { domain: object } }",
    "processes:",
    "  heat:",
    "    kind: atomic",
    "    inputs: { plate: { type: Plate, phase: data }, minutes: { type: Float, phase: graph } }",
    "    outputs: { plate: { type: Plate, phase: data } }",
    "    objects: { map: { outputs.plate: inputs.plate } }",
    "  main:",
    "    kind: composite",
    "    inputs: { plate: { type: Plate, phase: data } }",
    "    outputs: { plate: { type: Plate, phase: data } }",
    "    body:",
    "      nodes:",
    "        - { id: Heat, process: heat, state: { plate: { from: inputs.plate } }, bind: { minutes: { value: 2.5 } } }",
    "      returns: { plate: { from: Heat.plate } }",
    "entry: main",
  ].join("\n");
  await openWith(page, { name: "literal.workflow.yaml", workflow }, info.outputPath("literal.html"));
  await expect(page.locator("#banner")).toBeHidden();
  await page.locator('#graph [data-key="Heat"] rect.box').click();
  await expect(page.locator("#inspector")).toContainText("minutes = 2.5");
});

test("a thin page brings the viewer from the CDN and draws the same (D68)", async ({ page }, info) => {
  // Written by the Python command, as `lc export view --thin` would, and opened
  // from disk. The CDN is answered from this build's dist-cdn/ofp-view.js, so
  // the test needs no network and checks the file the release publishes.
  const cdnFile = fileURLToPath(new URL("../../dist-cdn/ofp-view.js", import.meta.url));
  const url = "https://cdn.jsdelivr.net/npm/@ofplang/export-viewer@0.0.0-test/ofp-view.js";
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const out = info.outputPath("thin.html");
  const [python, ...lead] = findPython();
  const run = spawnSync(
    python!,
    [...lead, "-m", "ofplang.export", "view", "datasets/curated/plate_assay.plan.yaml",
      "--thin", "--viewer-url", url, "--gantt", "object", "-o", out],
    { cwd: repo, encoding: "utf8" },
  );
  expect(run.status, `${python} said: ${run.stderr || run.error}`).toBe(0);
  // A few KB of documents, not the viewer.
  expect(readFileSync(out, "utf8").length).toBeLessThan(30_000);

  const fetched: string[] = [];
  await page.route(url, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      headers: { "access-control-allow-origin": "*" },
      body: readFileSync(cdnFile, "utf8"),
    }),
  );
  page.on("request", (r) => fetched.push(r.url()));
  await page.goto(pathToFileURL(out).href);

  await expect(page.locator("#plot rect.bar").first()).toBeVisible();
  await expect(page.locator('#views button[data-view="object"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#gutter [data-o]")).toHaveCount(5);
  await expect(page.locator("#graph g.gnode").first()).toBeVisible();
  await expect(page.locator('meta[name="ofp-viewer-build"]')).toHaveCount(1);
  // The viewer, and the fonts it asks for; nothing else.
  expect(fetched.filter((u) => !u.startsWith("file:") && u !== url && !/fonts\.(googleapis|gstatic)\.com/.test(u))).toEqual([]);
});

test("a page written to start without the details pane starts without it, even wide (D70)", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWith(
    page,
    {
      name: "simple.plan.yaml",
      plan: example("outputs/simple.plan.yaml"),
      workflow: example("simple.workflow.yaml"),
      ui: { details: "hide" },
    },
    info.outputPath("no-details.html"),
  );
  await expect(page.locator("#plot rect.bar").first()).toBeVisible();
  await expect(page.locator("aside")).toBeHidden();
  await expect(page.locator("#details")).toHaveAttribute("aria-pressed", "false");
  await page.locator("#details").click();
  await expect(page.locator("aside")).toBeVisible();
});
