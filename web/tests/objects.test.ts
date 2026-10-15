/**
 * Objects: their declarations (workflow spec §14, §15) and their lifelines
 * across every bundled plan (design.md §23).
 *
 * The golden half holds the derivation to what the specifications fix: every
 * move and relay belongs to exactly one Object, and a lifeline is contiguous in
 * time and in space — each stretch begins on the spot the last one ended on.
 * That last check is the derivation checking itself, since nothing in a plan
 * names an Object. The refusal half breaks a real plan one way at a time and
 * requires a reason rather than a drawing (D59).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { arcRoute, buildGraph, compositeKeys, edgeKey, graphTrail, moveRoute, processAt } from "../src/model/graph";
import { layoutGraph } from "../src/layout/graph";
import { objectsOf, traceObjects, unaccountedPorts, type ObjectTrace } from "../src/model/objects";
import { buildScene, type Scene } from "../src/model/scene";
import type { AtomicProcess, Workflow } from "../src/model/workflow";
import {
  readEnvironmentText,
  readExecutionDocument,
  readExecutionDocumentText,
  readWorkflow,
  readWorkflowText,
} from "../src/read";
import { documentFiles, read, workflowFiles } from "./golden/corpus";

const atomic = (yaml: string): { wf: Workflow; def: AtomicProcess } => {
  const wf = readWorkflowText(yaml);
  const def = wf.processes["p"];
  if (def?.kind !== "atomic") throw new Error("test workflow has no atomic p");
  return { wf, def };
};

const HEADER = `
spec_version: "0.0"
types: { Plate: { domain: object }, Tube: { domain: object } }
entry: main
`;
const MAIN = `
  main: { kind: composite, body: { nodes: [{ id: n, process: p }] } }
`;

describe("objectsOf", () => {
  it("takes a written objects section as it stands", () => {
    const { wf, def } = atomic(`${HEADER}
processes:
  p:
    kind: atomic
    behavior: [object_identity_map]
    inputs: { plate: { type: Plate, phase: data } }
    outputs: { plate: { type: Plate, phase: data } }
    objects: { consume: [inputs.plate], create: [outputs.plate] }
${MAIN}`);
    expect(def.behavior).toEqual(["object_identity_map"]);
    expect(objectsOf(def, wf)).toEqual({ consume: ["inputs.plate"], create: ["outputs.plate"] });
  });

  it("infers a map from the marker where objects is omitted", () => {
    const { wf, def } = atomic(`${HEADER}
processes:
  p:
    kind: atomic
    behavior: [object_identity_map]
    inputs:
      a: { type: Plate, phase: data }
      b: { type: Plate, phase: data }
      reading: { type: Float, phase: data }
    outputs:
      a: { type: Plate, phase: data }
      b: { type: Plate, phase: data }
      reading: { type: Float, phase: data }
${MAIN}`);
    // Pure Data has no slots (§14), so `reading` is not mapped.
    expect(objectsOf(def, wf)).toEqual({ map: { "outputs.a": "inputs.a", "outputs.b": "inputs.b" } });
  });

  it("pairs only the same name, type and phase", () => {
    const { wf, def } = atomic(`${HEADER}
processes:
  p:
    kind: atomic
    behavior: [object_identity_map]
    inputs:
      same: { type: Plate, phase: data }
      retyped: { type: Plate, phase: data }
      rephased: { type: Plate, phase: data }
      unpaired: { type: Plate, phase: data }
    outputs:
      same: { type: Plate, phase: data }
      retyped: { type: Tube, phase: data }
      rephased: { type: Plate, phase: done }
      other: { type: Plate, phase: data }
${MAIN}`);
    expect(objectsOf(def, wf)).toEqual({ map: { "outputs.same": "inputs.same" } });
  });

  it("gives nothing without either", () => {
    const { wf, def } = atomic(`${HEADER}
processes:
  p:
    kind: atomic
    inputs: { plate: { type: Plate, phase: data } }
${MAIN}`);
    expect(def.behavior).toBeUndefined();
    expect(objectsOf(def, wf)).toEqual({});
  });
});

const CURATED = fileURLToPath(new URL("../../datasets/curated/", import.meta.url));
const bundled: [string, string][] = [
  ...workflowFiles.map(([dir, name]) => [name, read(dir, name)] as [string, string]),
  ...readdirSync(CURATED)
    .filter((f) => f.endsWith(".workflow.yaml"))
    .map((f) => [f, readFileSync(join(CURATED, f), "utf8")] as [string, string]),
];

describe("every bundled Object-bearing port has a fate", () => {
  for (const [name, text] of bundled) it(name, () => expect(unaccountedPorts(readWorkflowText(text))).toEqual([]));
});

/* ── lifelines, against every bundled plan ─────────────────────────── */

const SUBMODULE = fileURLToPath(new URL("../../external/ofplang-schedule/", import.meta.url));

/** Every plan the viewer bundles, each with the workflow and environment its
 *  own `meta` names — the way `collect-datasets` pairs them. */
const plans: [string, Scene][] = [
  ...documentFiles.map(([dir, f]) => [f, sceneFrom(read(dir, f), SUBMODULE)] as [string, Scene]),
  ...readdirSync(CURATED)
    .filter((f) => f.endsWith(".plan.yaml"))
    .map((f) => [f, sceneFrom(readFileSync(join(CURATED, f), "utf8"), CURATED)] as [string, Scene]),
];

function sceneFrom(text: string, root: string): Scene {
  const doc = readExecutionDocumentText(text);
  const beside = (rel: string | undefined): string | undefined =>
    rel ? readFileSync(join(root, rel), "utf8") : undefined;
  // A plan of several jobs names a workflow per job; drawn against one where they are all one (D75).
  const named = doc.meta?.workflows ? [...new Set(doc.meta.workflows)] : undefined;
  const wf = beside(named ? (named.length === 1 ? named[0] : undefined) : doc.meta?.workflow);
  const env = beside(doc.meta?.environment);
  return buildScene(doc, env ? readEnvironmentText(env) : undefined, wf ? readWorkflowText(wf) : undefined);
}

const traced = (scene: Scene): readonly ObjectTrace[] => {
  const t = traceObjects(scene);
  if (!t.ok) throw new Error(t.reasons.join("; "));
  return t.traces;
};

it("the corpus is the twelve bundled plans", () => {
  expect(plans.length).toBeGreaterThanOrEqual(12);
});

describe("every bundled plan traces", () => {
  for (const [name, scene] of plans)
    describe(name, () => {
      const traces = traced(scene);

      it("every move and every relay belongs to exactly one Object", () => {
        const owners = new Map<number, number>();
        for (const t of traces) for (const i of t.activities) owners.set(i, (owners.get(i) ?? 0) + 1);
        scene.activities.forEach((a, i) => {
          if (a.kind === "transport" || a.kind === "relay") expect(owners.get(i), `activity ${i}`).toBe(1);
        });
      });

      it("a lifeline is contiguous, and each stretch begins where the last one ended", () => {
        for (const t of traces)
          t.segments.forEach((s, k) => {
            expect(s.end, `${t.id} #${k}`).toBeGreaterThanOrEqual(s.start);
            const prev = t.segments[k - 1];
            if (!prev) return;
            expect(s.start, `${t.id} #${k} time`).toBe(prev.end);
            if (prev.to && s.from) expect(s.from, `${t.id} #${k} spot`).toBe(prev.to);
          });
      });

      it("a lifeline runs from its first step's start to its last step's end, or to the horizon", () => {
        for (const t of traces) {
          const first = t.segments[0]!;
          const last = t.segments[t.segments.length - 1]!;
          if (t.origin.kind === "input") expect(first.start).toBe(0);
          else expect(first.activity).toBe(t.activities[0]);
          if (t.fate.kind === "consume") expect(last.activity).toBe(t.activities[t.activities.length - 1]);
          else expect(last.end).toBe(scene.metrics.horizon);
        }
      });
    });
});

describe("the shapes the design expects (design.md §23)", () => {
  const byName = new Map(plans.map(([n, s]) => [n, traced(s)]));
  const summary = (name: string) =>
    byName.get(name)!.map((t) => ({ label: t.label, fate: t.fate.kind, moves: t.arcs.length }));

  it("plate_batch: two plates, each through every repeat unit of its branch", () => {
    const t = byName.get("plate_batch.plan.yaml")!;
    expect(t.map((x) => x.label)).toEqual(["Plate · source.plate_1", "Plate · source.plate_2"]);
    for (const x of t) expect(x.fate.kind).toBe("consume");
    for (const x of t) expect(x.arcs.length).toBeGreaterThan(5);
  });

  it("storage: three plates, each resting in the fridge", () => {
    const t = byName.get("storage.plan.yaml")!;
    expect(summary("storage.plan.yaml")).toEqual([
      { label: "Plate · PrepA.plate", fate: "consume", moves: 2 },
      { label: "Plate · PrepB.plate", fate: "consume", moves: 2 },
      { label: "Plate · PrepC.plate", fate: "consume", moves: 2 },
    ]);
    for (const x of t) expect(x.segments.map((s) => s.kind)).toContain("resting");
  });

  it("plate_assay: five Objects of two types, each with its own fate", () => {
    const t = byName.get("plate_assay.plan.yaml")!;
    const fate = (x: ObjectTrace) =>
      `${x.origin.kind} -> ${x.fate.kind}${"node" in x.fate ? ` at ${x.fate.node.join(".")}` : ""}`;
    expect(Object.fromEntries(t.map((x) => [x.label, fate(x)]))).toEqual({
      "Plate · NewPlate.plate": "create -> output",
      "Plate · inputs.standards": "input -> consume at DiscardStandards",
      "SampleTube · inputs.sample_1": "input -> consume at AddSample1.DiscardTube",
      "SampleTube · inputs.sample_2": "input -> consume at AddSample2.DiscardTube",
      "SampleTube · inputs.sample_3": "input -> consume at AddSample3.DiscardTube",
    });
    // The plate rests in the incubator while the machine stays free (§4.4.2).
    const plate = t.find((x) => x.origin.kind === "create")!;
    expect(plate.segments.filter((s) => s.kind === "resting")).toHaveLength(2);
  });

  it("reformatter: every step creates and consumes, so every Object is one move", () => {
    const t = byName.get("reformatter.plan.yaml")!;
    expect(t).toHaveLength(12);
    for (const x of t) expect(x.arcs).toHaveLength(1);
  });
});

/* ── what is refused rather than drawn (design.md D59) ─────────────── */

describe("a lifeline that cannot be followed is not drawn", () => {
  const STORAGE = join(SUBMODULE, "examples");
  const planRaw = (): Record<string, unknown> =>
    parse(readFileSync(join(SUBMODULE, "examples/outputs/storage.plan.yaml"), "utf8")) as Record<string, unknown>;
  const wfRaw = (): Record<string, unknown> =>
    parse(readFileSync(join(STORAGE, "storage.workflow.yaml"), "utf8")) as Record<string, unknown>;
  const env = readEnvironmentText(readFileSync(join(STORAGE, "storage.env.yaml"), "utf8"));
  type Act = { kind: string; arc?: { from: { node: string[] } }; from_spot?: string };
  const moves = (plan: Record<string, unknown>) => plan["activities"] as Act[];
  const reasons = (plan: Record<string, unknown>, wf: Record<string, unknown> | null = wfRaw()): string[] => {
    const t = traceObjects(buildScene(readExecutionDocument(plan), env, wf ? readWorkflow(wf) : undefined));
    return t.ok ? [] : [...t.reasons];
  };

  it("draws the untouched plan", () => {
    expect(reasons(planRaw())).toEqual([]);
  });

  it("without a workflow", () => {
    expect(reasons(planRaw(), null)[0]).toMatch(/no workflow/);
  });

  it("when a step's Object ports have no declaration", () => {
    const wf = wfRaw();
    delete ((wf["processes"] as Record<string, Record<string, unknown>>)["chill"]!)["objects"];
    expect(reasons(planRaw(), wf)).toEqual([
      "chill.inputs.plate carries an Object but no `objects` declaration accounts for it",
      "chill.outputs.out carries an Object but no `objects` declaration accounts for it",
    ]);
  });

  it("when a move is missing — not drawn as a plate left where it was", () => {
    const plan = planRaw();
    plan["activities"] = moves(plan).filter((a) => !(a.kind === "transport" && a.arc!.from.node[0] === "ChillA"));
    expect(reasons(plan)).toEqual(["ChillA.out: the plan moves it nowhere"]);
  });

  it("when two stretches do not meet on the same spot", () => {
    const plan = planRaw();
    const move = moves(plan).find((a) => a.kind === "transport" && a.arc!.from.node[0] === "ChillB")!;
    move.from_spot = "fridge.slot_1";
    expect(reasons(plan)).toEqual(["PrepB.plate: it is left on fridge.slot_2 but next taken from fridge.slot_1"]);
  });

  it("when an entry input is never brought in", () => {
    const text = readFileSync(join(CURATED, "data_flow.plan.yaml"), "utf8");
    const plan = parse(text) as Record<string, unknown>;
    plan["activities"] = moves(plan).filter((a) => !(a.kind === "transport" && a.arc!.from.node.length === 0));
    const wf = parse(readFileSync(join(CURATED, "data_flow.workflow.yaml"), "utf8"));
    const t = traceObjects(buildScene(readExecutionDocument(plan), undefined, readWorkflow(wf)));
    expect(t.ok ? [] : t.reasons).toEqual(["Measure.plate: the plan brings no Object to it"]);
  });
});

/* ── the route an arc takes through the drawn graph ────────────────── */

describe("every plan arc runs along connections the graph draws", () => {
  for (const [name, scene] of plans) {
    if (!scene.workflow) continue;
    it(name, () => {
      const graph = buildGraph(scene.workflow!);
      const drawn = new Set(layoutGraph(graph, new Set(compositeKeys(graph))).edges.map(edgeKey));
      for (const [key, legs] of scene.byArc) {
        const a = scene.activities[legs[0]!]!;
        if (!("arc" in a)) continue;
        // What runs at either end picks a branch's atomic arm, as the app looks it up.
        const route = moveRoute(scene, graph, a.arc);
        expect(route, key).toBeDefined();
        // Round a fold's or a loop's carry inside one box, nothing is drawn to follow.
        const box = (p: typeof a.arc.from.node) => graphTrail(graph, p, processAt(scene, p)).at(-1)?.key;
        if (box(a.arc.from.node) !== box(a.arc.to.node)) expect(route!.length, key).toBeGreaterThan(0);
        // Fully open, every step of the route is on screen.
        for (const e of route!) expect(drawn.has(edgeKey(e)), `${key}: ${edgeKey(e)}`).toBe(true);
      }
    });
  }

  it("into a nested composite, the route crosses each border it passes", () => {
    const [, scene] = plans.find(([n]) => n === "plate_batch.plan.yaml")!;
    const graph = buildGraph(scene.workflow!);
    const route = arcRoute(graph, {
      from: { node: ["source"], port: "plate_1" },
      to: { node: ["b1", "rep1", "peal"], port: "plate" },
    })!;
    expect(route.map((e) => `${e.fromKey}>${e.toKey}`)).toEqual(["source>b1", "b1>b1.rep1", "b1.rep1>b1.rep1.peal"]);
  });
});
