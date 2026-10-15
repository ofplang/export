/**
 * The workflow graph: its tree, and where the boxes land.
 *
 * Overlap and containment are exactly the properties a picture has to have and
 * a person notices instantly, so they are worth asserting rather than eyeing.
 */

import { describe, expect, it } from "vitest";

import { ancestorKeys, buildGraph, carriesObject, compositeKeys, findNode, visibleFor } from "../src/model/graph";
import { layoutGraph, type LaidNode } from "../src/layout/graph";
import { readWorkflowText } from "../src/read";
import { read, triples } from "./golden/corpus";

const workflowOf = (name: string) => {
  const t = triples.find((x) => x.name === name)!;
  return readWorkflowText(read(...t.workflow));
};

const plateBatch = buildGraph(workflowOf("plate_batch"));
const reformatter = buildGraph(workflowOf("reformatter"));

const overlaps = (a: LaidNode, b: LaidNode): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("the tree", () => {
  it("is the source structure, not the expansion (D11)", () => {
    // main holds four nodes; the twenty atomic steps are inside two of them.
    expect(plateBatch.children.map((c) => c.id)).toEqual(["source", "b1", "b2", "sink"]);
    expect(plateBatch.atomicCount).toBe(22);
    const b1 = plateBatch.children.find((c) => c.id === "b1")!;
    expect(b1.kind).toBe("composite");
    expect(b1.atomicCount).toBe(10);
    expect(b1.children.map((c) => c.id)).toEqual(["rep1", "rep2"]);
  });

  it("carries the ports of the process each node invokes", () => {
    const source = plateBatch.children.find((c) => c.id === "source")!;
    expect(source.outputs).toEqual(["plate_1", "plate_2"]);
    expect(source.inputs).toEqual([]);
  });

  it("marks Object-bearing bindings apart from Pure Data", () => {
    const b1 = plateBatch.children.find((c) => c.id === "b1")!;
    expect(Object.values(b1.bindings).every((b) => b.object)).toBe(true);
  });

  it("finds a node by key, and lists what expand-all opens", () => {
    expect(findNode(plateBatch, "b2.rep1.peal")?.process).toBe("peal");
    expect(findNode(plateBatch, "nope")).toBeUndefined();
    expect(compositeKeys(plateBatch).sort()).toEqual(
      ["b1", "b1.rep1", "b1.rep2", "b2", "b2.rep1", "b2.rep2"].sort(),
    );
  });
});

describe("which box stands for a node", () => {
  it("is the closed composite when the path runs inside one", () => {
    expect(visibleFor(plateBatch, ["b2", "rep1", "peal"], new Set())).toBe("b2");
    expect(visibleFor(plateBatch, ["b2", "rep1", "peal"], new Set(["b2"]))).toBe("b2.rep1");
    expect(visibleFor(plateBatch, ["b2", "rep1", "peal"], new Set(["b2", "b2.rep1"]))).toBe(
      "b2.rep1.peal",
    );
  });

  it("is the entry composite for a boundary endpoint", () => {
    expect(visibleFor(plateBatch, [], new Set())).toBe("");
  });

  it("lists the boxes between the root and a node", () => {
    expect(ancestorKeys(plateBatch, ["b2", "rep1", "peal"])).toEqual(["b2", "b2.rep1"]);
    expect(ancestorKeys(plateBatch, ["source"])).toEqual([]);
  });
});

describe("the layout, closed", () => {
  const l = layoutGraph(plateBatch, new Set());

  it("draws the entry composite as the shell and its four nodes inside", () => {
    expect(l.shells).toHaveLength(1);
    expect(l.leaves.map((n) => n.key).sort()).toEqual(["b1", "b2", "sink", "source"]);
  });

  it("keeps every box inside its container", () => {
    const shell = l.shells[0]!;
    for (const leaf of l.leaves) {
      expect(leaf.x).toBeGreaterThanOrEqual(shell.x);
      expect(leaf.y).toBeGreaterThanOrEqual(shell.y);
      expect(leaf.x + leaf.w).toBeLessThanOrEqual(shell.x + shell.w);
      expect(leaf.y + leaf.h).toBeLessThanOrEqual(shell.y + shell.h);
    }
  });

  it("never puts two boxes on top of each other", () => {
    for (let i = 0; i < l.leaves.length; i++)
      for (let j = i + 1; j < l.leaves.length; j++)
        expect(overlaps(l.leaves[i]!, l.leaves[j]!), `${l.leaves[i]!.key} / ${l.leaves[j]!.key}`).toBe(
          false,
        );
  });

  it("puts a reader to the right of what it reads", () => {
    const at = (key: string) => l.leaves.find((n) => n.key === key)!;
    expect(at("source").x).toBeLessThan(at("b1").x);
    expect(at("b1").x).toBeLessThan(at("sink").x);
    // Branches that read the same source share a column.
    expect(at("b1").x).toBe(at("b2").x);
  });

  it("anchors every edge on a port of the boxes it joins", () => {
    expect(l.edges.length).toBeGreaterThan(0);
    const all = [...l.shells, ...l.leaves];
    for (const e of l.edges) {
      const from = all.find((n) => n.key === e.fromKey)!;
      const to = all.find((n) => n.key === e.toKey)!;
      expect(from.outputs.some((a) => Math.abs(a.x - e.from.x) < 0.5 && Math.abs(a.y - e.from.y) < 0.5)).toBe(true);
      expect(to.inputs.some((a) => Math.abs(a.x - e.to.x) < 0.5 && Math.abs(a.y - e.to.y) < 0.5)).toBe(true);
    }
  });
});

describe("the layout, opened", () => {
  it("nests, and still does not overlap", () => {
    const l = layoutGraph(plateBatch, new Set(compositeKeys(plateBatch)));
    expect(l.shells.length).toBe(7); // the entry composite, two branches, four units
    expect(l.leaves).toHaveLength(22);

    for (let i = 0; i < l.leaves.length; i++)
      for (let j = i + 1; j < l.leaves.length; j++)
        expect(overlaps(l.leaves[i]!, l.leaves[j]!)).toBe(false);

    // Siblings at the same depth do not overlap either.
    const byDepth = new Map<number, LaidNode[]>();
    for (const s of l.shells) (byDepth.get(s.depth) ?? byDepth.set(s.depth, []).get(s.depth)!).push(s);
    for (const [, group] of byDepth)
      for (let i = 0; i < group.length; i++)
        for (let j = i + 1; j < group.length; j++)
          expect(overlaps(group[i]!, group[j]!), `${group[i]!.key} / ${group[j]!.key}`).toBe(false);
  });

  it("grows the picture when something is opened", () => {
    const shut = layoutGraph(plateBatch, new Set());
    const open = layoutGraph(plateBatch, new Set(["b2"]));
    expect(open.width).toBeGreaterThan(shut.width);
    expect(open.height).toBeGreaterThan(shut.height);
  });

  it("puts a child's boxes inside its shell", () => {
    const l = layoutGraph(plateBatch, new Set(["b2", "b2.rep1"]));
    const shell = l.shells.find((s) => s.key === "b2.rep1")!;
    const inside = l.leaves.filter((n) => n.key.startsWith("b2.rep1."));
    expect(inside).toHaveLength(5);
    for (const n of inside) {
      expect(n.x).toBeGreaterThanOrEqual(shell.x);
      expect(n.x + n.w).toBeLessThanOrEqual(shell.x + shell.w);
      expect(n.y).toBeGreaterThanOrEqual(shell.y);
      expect(n.y + n.h).toBeLessThanOrEqual(shell.y + shell.h);
    }
  });
});

describe("a wide fan-out", () => {
  // reformatter is the case that makes port-level anchoring worth having:
  // eight steps, several with three inputs and two outputs (D19).
  const l = layoutGraph(reformatter, new Set());

  it("gives every port of every box its own anchor", () => {
    for (const n of l.leaves) {
      expect(n.inputs.map((a) => a.port)).toEqual([...n.node.inputs]);
      expect(n.outputs.map((a) => a.port)).toEqual([...n.node.outputs]);
      const ys = n.inputs.map((a) => a.y);
      expect(new Set(ys).size).toBe(ys.length);
    }
  });

  it("draws one edge per binding, not one per pair of boxes", () => {
    const bindings = l.leaves.reduce((n, x) => n + Object.keys(x.node.bindings).length, 0);
    const returns = Object.keys(reformatter.returns).length;
    expect(l.edges).toHaveLength(bindings + returns);
  });

  it("lands each input of a three-input step on its own anchor", () => {
    // reformatter_20 reads from three different steps at once — the case that
    // is ambiguous if edges are drawn between boxes rather than ports (D19).
    const rf20 = l.leaves.find((n) => n.node.process === "reformatter_20")!;
    expect(rf20.node.inputs).toHaveLength(3);

    const inbound = l.edges.filter((e) => e.toKey === rf20.key);
    expect(inbound).toHaveLength(3);
    const ys = inbound.map((e) => e.to.y);
    expect(new Set(ys).size).toBe(3);
    // Three distinct senders, each arriving at its own port.
    expect(new Set(inbound.map((e) => e.fromKey)).size).toBe(3);
  });
});

describe("what an edge carries", () => {
  // The pinned examples only ever carry Objects (Plate, Sample), so the Pure
  // Data side is written out here: a measurement returned as a Float, and a
  // unit-suffixed Float whose unit shares a name with an object type.
  const wf = readWorkflowText(`
spec_version: "0.0"
types:
  Plate: { domain: object }
  ms: { domain: object }
processes:
  read:
    kind: atomic
    inputs:  { plate: { type: Plate, phase: data } }
    outputs: { plate: { type: Plate, phase: data }, od: { type: Float, phase: data }, t: { type: "Float[ms]", phase: data } }
  log:
    kind: atomic
    inputs:  { value: { type: Float, phase: data } }
  assay:
    kind: composite
    inputs:  { plate: { type: Plate, phase: data } }
    outputs: { plate: { type: Plate, phase: data }, od: { type: Float, phase: data }, t: { type: "Float[ms]", phase: data } }
    body:
      nodes:
        - id: Read
          process: read
          state: { plate: { from: inputs.plate } }
        - id: Log
          process: log
          bind: { value: { from: Read.od } }
      returns:
        plate: { from: Read.plate }
        od: { from: Read.od }
        t: { from: Read.t }
entry: assay
`);
  const graph = buildGraph(wf);
  const { edges } = layoutGraph(graph, new Set());
  const edge = (fromPort: string, toKey: string, toPort: string) =>
    edges.find((e) => e.fromPort === fromPort && e.toKey === toKey && e.toPort === toPort)!;

  it("names the declared type at both ends", () => {
    const plateIn = edge("plate", "Read", "plate");
    expect([plateIn.fromType, plateIn.toType, plateIn.object]).toEqual(["Plate", "Plate", true]);
    const od = edge("od", "Log", "value");
    expect([od.fromType, od.toType, od.object]).toEqual(["Float", "Float", false]);
  });

  it("types a port by its side, when a box has an input and an output of one name", () => {
    // `Read` has `plate` in and `plate` out; the returned one is the output.
    const back = edge("plate", "", "plate");
    expect(back.fromKey).toBe("Read");
    expect(back.fromType).toBe("Plate");
  });

  it("takes a returned output's kind from its type, not a fixed Object", () => {
    expect(edge("plate", "", "plate").object).toBe(true);
    expect(edge("od", "", "od").object).toBe(false);
  });

  it("does not read a unit suffix as a type name", () => {
    const t = edge("t", "", "t");
    expect(t.fromType).toBe("Float[ms]");
    expect(t.object).toBe(false);
    expect(carriesObject("Array<Plate>", wf)).toBe(true);
    expect(carriesObject("Int", wf)).toBe(false);
  });
});
