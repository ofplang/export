/**
 * Collect the bundled datasets from the pinned submodule (design.md D9 ① / D24).
 *
 * Runs before dev and build, writes into `public/datasets/`, which is
 * gitignored — the submodule pin is the source of truth, not a copy of it.
 * A dataset that is *not* in the submodule goes in `datasets/curated/` and is
 * committed; this script picks those up too.
 *
 * Node only: no Python, no ortools, nothing the CI does not already have (D7).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const SUBMODULE_ROOT = here("../../external/ofplang-schedule");
const SUBMODULE = here("../../external/ofplang-schedule/examples");
const CURATED = here("../../datasets/curated");
const OUT = here("../public/datasets");

/** One line each, so the picker says what a dataset is for. */
const BLURBS = {
  simple: "The smallest end-to-end case: one transport, two devices.",
  two_arms: "Two transporters competing for the same moves.",
  reformatter: "Eight plate operations that fan out and merge back.",
  plate_batch: "Three levels of nesting — two branches of two repeat units.",
  interface_load: "Boundary material: the workflow's entry input is pinned to a spot.",
  consumable: "A reagent the reader starts without, and the single refill that covers both assays.",
  reroute: "The planned transporter is gone, so the rest of the move is replanned around it.",
  reroute_chain: "A move that takes two hops, with the plate waiting at a relay in between.",
  reroute_stay: "A re-route where the plate stays put, so the relay folds out of the plan.",
  storage: "A plate resting in storage: its spot is held, the device stays free for other work.",
  data_flow: "Pure Data beside a plate: a reading scored on no device, returned as the workflow's output.",
  shared_bay: "Two jobs of one workflow taking turns at one loading bay.",
  shared_refill: "Two jobs of one workflow sharing a stock: the refill neither needs alone.",
  stopped_job: "Three jobs, one of which failed: the others are planned around what it left behind.",
  plate_assay:
    "A plate assay: three sample tubes and a plate of standards onto a fresh plate, which is developed, read and returned; the tubes and the standards are discarded.",
};

/**
 * The one workflow a plan's `meta` names: its `workflow`, or — for a plan of
 * several jobs (§6.11) — the file every job names, where they all name the
 * same one. Jobs of different workflows are drawn without one (design.md D75),
 * so none is offered.
 */
const metaWorkflow = (plan) => {
  const w = plan?.meta?.workflow;
  if (!Array.isArray(w)) return w;
  const named = [...new Set(w)];
  return named.length === 1 ? named[0] : undefined;
};


const prettify = (id) =>
  id.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function readYaml(path) {
  return parse(readFileSync(path, "utf8"));
}

/** Every `<name>.plan.yaml` / `<name>.replan.yaml`, with whatever sits beside it.
 *
 * `roots` are the directories a plan's own `meta` paths are relative to. Those
 * paths are the authority: a replan usually reuses another example's workflow
 * — every `reroute*.replan.yaml` runs on `simple.workflow.yaml` — and matching
 * by filename silently loses it, leaving the graph pane empty (§6.1 `meta`).
 */
function collectFrom(dir, origin, roots) {
  if (!safeList(dir).length) return [];
  const outputs = join(dir, "outputs");
  const search = [dir, ...(safeList(outputs).length ? [outputs] : [])];

  const find = (name) => {
    for (const d of search) {
      const hit = safeList(d).find((f) => f === name);
      if (hit) return join(d, hit);
    }
    return undefined;
  };

  const planFiles = search.flatMap((d) =>
    safeList(d)
      .filter((f) => f.endsWith(".plan.yaml") || f.endsWith(".replan.yaml"))
      .map((f) => join(d, f)),
  );

  return planFiles.flatMap((planPath) => {
    const file = basename(planPath);
    const replan = file.endsWith(".replan.yaml");
    const name = file.replace(/\.(re)?plan\.yaml$/, "");
    const id = replan ? `${name}_replan` : name;

    const plan = readYaml(planPath);

    const fromMeta = (rel) => {
      if (typeof rel !== "string" || !rel) return undefined;
      for (const root of roots) {
        const candidate = join(root, rel);
        if (existsSync(candidate)) return candidate;
      }
      return undefined;
    };

    const workflowPath = fromMeta(metaWorkflow(plan)) ?? find(`${name}.workflow.yaml`);
    const envPath = fromMeta(plan.meta?.environment) ?? find(`${name}.env.yaml`);
    const dataset = {
      id,
      label: prettify(name) + (replan ? " (replan)" : ""),
      blurb: replan
        ? [BLURBS[name], "Re-optimised partway through the run."].filter(Boolean).join(" ")
        : (BLURBS[name] ?? `${prettify(name)} — from ${origin}.`),
      origin,
      source: {
        plan: relative(planPath),
        workflow: workflowPath ? relative(workflowPath) : null,
        environment: envPath ? relative(envPath) : null,
      },
      plan,
      workflow: workflowPath ? readYaml(workflowPath) : null,
      environment: envPath ? readYaml(envPath) : null,
    };
    return [dataset];
  });
}

const safeList = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const relative = (p) => p.replace(/\\/g, "/").replace(/^.*\/(examples|curated)\//, "$1/");

const datasets = [
  ...collectFrom(SUBMODULE, "ofplang-schedule (pinned submodule)", [SUBMODULE_ROOT]),
  ...collectFrom(CURATED, "curated in this repository", [CURATED, SUBMODULE_ROOT]),
].sort((a, b) => (a.plan.activities?.length ?? 0) - (b.plan.activities?.length ?? 0));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const index = datasets.map((d) => {
  writeFileSync(join(OUT, `${d.id}.json`), JSON.stringify(d));
  return {
    id: d.id,
    label: d.label,
    blurb: d.blurb,
    origin: d.origin,
    activities: d.plan.activities?.length ?? 0,
    hasWorkflow: d.workflow !== null,
    hasEnvironment: d.environment !== null,
  };
});
writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 2));

console.log(
  `collect-datasets: ${index.length} datasets -> public/datasets/\n` +
    index.map((d) => `  ${d.id.padEnd(20)} ${String(d.activities).padStart(3)} activities`).join("\n"),
);
