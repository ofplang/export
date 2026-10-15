/**
 * Structured nodes (workflow spec §17-§20) and what a plan says about them
 * (SPEC §6.3, §6.13-§6.16): read as written, drawn as the one node they are,
 * counted from the plan, followed through their gates.
 */

import { describe, expect, it } from "vitest";

import { annotate } from "../src/model/annotate";
import { activitiesOn, buildGraph, findNode, type GraphNode } from "../src/model/graph";
import { traceObjects } from "../src/model/objects";
import { buildScene, type Scene } from "../src/model/scene";
import { readEnvironmentText, readExecutionDocumentText, readWorkflowText } from "../src/read";
import { read, triples } from "./golden/corpus";

const plan = (activities: string, extra = ""): string => `time: {unit: second}\n${extra}activities:\n${activities}`;

describe("node paths (§6.3)", () => {
  const at = (node: string) =>
    plan(`- {kind: processing, start: 0, end: 1, process: p, mode: m, node: ${node}}\n`);

  it("reads an invocation's position after its node's id", () => {
    const doc = readExecutionDocumentText(at("[Outer, 0, Inner, 3, step]"));
    expect(doc.activities[0]!.kind === "processing" && doc.activities[0]!.node).toEqual(["Outer", 0, "Inner", 3, "step"]);
  });

  it.each([
    ["[0, step]", /starts with a node id/],
    ["[Wash, 1, 2, step]", /side by side/],
    ["[Wash, -1, step]", /non-negative integer/],
    ["[Wash, 1.5, step]", /non-negative integer/],
    ["[Wash, '@out']", /names its port/],
  ])("refuses %s", (node, why) => {
    expect(() => readExecutionDocumentText(at(node))).toThrow(why);
  });

  it("reads a gate's path with its port and an element's position", () => {
    const doc = readExecutionDocumentText(plan(`- {kind: gate, start: 3, end: 3, node: [Choose, '@out', cups, 1], spot: rack.a}\n`));
    expect(doc.activities[0]).toMatchObject({ kind: "gate", node: ["Choose", "@out", "cups", 1], spot: "rack.a" });
  });

  it("refuses a gate whose path does not name one", () => {
    expect(() => readExecutionDocumentText(plan(`- {kind: gate, start: 3, end: 3, node: [Choose]}\n`))).toThrow(/@out/);
  });
});

describe("decisions, gates and reservations (§6.14-§6.16)", () => {
  it("reads a decision as written", () => {
    const doc = readExecutionDocumentText(
      plan(`- {kind: decision, start: 5, end: 5, node: [Clean], iteration: 0, arm: exit, assumed: true, condition: {node: [Clean, 0, Read], port: dirty}}\n`),
    );
    expect(doc.activities[0]).toMatchObject({
      kind: "decision", node: ["Clean"], iteration: 0, arm: "exit", assumed: true,
      condition: { node: ["Clean", 0, "Read"], port: "dirty" },
    });
  });

  it("refuses a decision that does not say whether it is assumed", () => {
    expect(() =>
      readExecutionDocumentText(plan(`- {kind: decision, start: 5, end: 5, node: [H], arm: then, condition: {node: [I], port: d}}\n`)),
    ).toThrow(/assumed/);
  });

  it("refuses a decision or a gate that takes time", () => {
    expect(() =>
      readExecutionDocumentText(plan(`- {kind: decision, start: 5, end: 6, node: [H], arm: then, assumed: true, condition: {node: [I], port: d}}\n`)),
    ).toThrow(/instantaneous/);
  });

  it("refuses a reservation that keeps nothing", () => {
    expect(() => readExecutionDocumentText(plan(`- {kind: reservation, start: 0, end: 4, node: [H], spots: []}\n`))).toThrow(/at least one spot/);
  });

  it("reads expansion, and an interface that binds an Array to a list of spots", () => {
    const doc = readExecutionDocumentText(
      plan(
        "",
        "interface: {inputs: {cups: [tray.a, tray.b]}}\n" +
          "expansion: {arms: [{node: [Each, 0, Choose], arm: else}], loops: [{node: [L], count: 2, ended: true}], " +
          "lengths: [{node: [I], port: redo, length: 3}]}\n",
      ).replace("activities:\n", "activities: []\n"),
    );
    expect(doc.interface?.inputs["cups"]).toEqual(["tray.a", "tray.b"]);
    expect(doc.expansion).toEqual({
      arms: [{ node: ["Each", 0, "Choose"], arm: "else" }],
      loops: [{ node: ["L"], count: 2, ended: true }],
      lengths: [{ node: ["I"], port: "redo", length: 3 }],
    });
  });
});

/** A bundled example, as the viewer loads it. */
function example(name: string): { scene: Scene; graph: GraphNode } {
  const t = triples.find((x) => x.name === name)!;
  const wf = readWorkflowText(read(...t.workflow));
  const scene = buildScene(readExecutionDocumentText(read(...t.plan)), readEnvironmentText(read(...t.environment)), wf);
  return { scene, graph: buildGraph(wf) };
}

describe("the graph draws each structured node once", () => {
  it("a map over a composite, holding a branch with its two arms", () => {
    const { graph } = example("inspect_then_wash");
    const each = findNode(graph, "Each")!;
    expect(each.structure).toBe("map");
    expect(each.kind).toBe("composite");
    expect(each.inputTypes["cup"]).toBe("Array<Cup>");
    const choose = findNode(graph, "Each.Choose")!;
    expect(choose.structure).toBe("branch");
    expect(choose.children.map((a) => [a.id, a.process])).toEqual([["@then", "wash"], ["@else", "polish"]]);
    // A common output comes back from either arm (§20).
    expect(choose.returns["cup"]).toEqual(["@then.cup", "@else.cup"]);
    expect(choose.bindings["condition"]).toEqual({ from: "Look.dirty", object: false });
  });

  it("a loop exposes its carry and its `exhausted` (§19.3)", () => {
    const { graph } = example("rinse_until_clean");
    const clean = findNode(graph, "Clean")!;
    expect(clean.structure).toBe("do_while");
    expect(clean.outputs).toEqual(["plate", "exhausted"]);
    expect(clean.limit).toBe("5");
  });
});

describe("what the plan says of them", () => {
  it("counts a map's invocations, and the arm each assumes", () => {
    const { scene, graph } = example("inspect_then_wash");
    const notes = annotate(scene, graph);
    expect(notes.get("Each")).toEqual({ invocations: 3 });
    expect(notes.get("Each.Choose.@then")).toEqual({ ran: 0, assumed: 3 });
    expect(notes.get("Each.Choose.@else")).toEqual({ ran: 0, assumed: 0 });
  });

  it("counts the arms the run stated", () => {
    const { scene, graph } = example("wash_or_polish");
    const notes = annotate(scene, graph);
    expect(notes.get("Each.Choose.@then")).toEqual({ ran: 2, assumed: 0 });
    expect(notes.get("Each.Choose.@else")).toEqual({ ran: 1, assumed: 0 });
  });

  it("marks only the work inside an assumed arm as assumed", () => {
    expect(example("wash_or_polish").scene.assumed.size).toBe(0);
    const { scene } = example("inspect_then_wash");
    const steps = [...scene.assumed].map((i) => scene.activities[i]!).filter((a) => a.kind === "processing");
    expect(steps.map((a) => a.kind === "processing" && a.process)).toEqual(["wash", "wash", "wash"]);
  });

  it("an arm stands for what ran in it, and nothing of the other", () => {
    const { scene, graph } = example("wash_or_polish");
    const processes = (key: string) =>
      activitiesOn(scene, graph, key)
        .map((i) => scene.activities[i]!)
        .flatMap((a) => (a.kind === "processing" ? [a.process] : []));
    expect(processes("Each.Choose.@then")).toEqual(["wash", "wash"]);
    expect(processes("Each.Choose.@else")).toEqual(["polish"]);
  });
});

describe("Objects through structured nodes", () => {
  it("an Object passes through each invocation's gate, on the gate's spot", () => {
    const { scene } = example("rinse_until_clean");
    const t = traceObjects(scene);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    const gates = t.traces[0]!.segments.filter((s) => s.kind === "gate");
    expect(gates).toHaveLength(1);
    expect(gates[0]!.from).toBe("reader.slot");
  });

  it("an Array at the boundary is one Object per element", () => {
    const { scene } = example("dispense_read");
    const t = traceObjects(scene);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.traces.map((x) => x.where).sort()).toEqual([
      "inputs.plates[0]", "inputs.plates[1]", "inputs.plates[2]", "inputs.reagent",
    ]);
    expect(t.traces.find((x) => x.where === "inputs.plates[1]")?.type).toBe("Plate");
  });
});
