/**
 * Literal binding source entries (workflow spec 2.6.6, 11.1.1).
 *
 * A source entry is exactly one of `from` or `value`. Until 0.1.3 the reader
 * took every entry for a `from`, so a workflow with a single literal did not
 * open at all — the LabOP translations in ofplang-case-studies were the first
 * seen to have them. A literal has no source, so it draws no connection; the
 * node's panel shows it with its port instead.
 */

import { describe, expect, it } from "vitest";

import { buildGraph, findNode } from "../src/model/graph";
import { layoutGraph } from "../src/layout/graph";
import { readWorkflowText, ReadError } from "../src/read";
import { renderNodeDetail } from "../src/view/inspector";

const workflow = (main: string): string => `
spec_version: "0.0"
types: { Plate: { domain: object } }
processes:
  heat:
    kind: atomic
    inputs:
      plate: { type: Plate, phase: data }
      minutes: { type: Float, phase: graph }
    outputs:
      plate: { type: Plate, phase: data }
    objects: { map: { outputs.plate: inputs.plate } }
  main:
    kind: composite
    inputs: { plate: { type: Plate, phase: data } }
    outputs:
      plate: { type: Plate, phase: data }
      label: { type: String, phase: graph }
${main}
entry: main
`;

const HEAT = `
    body:
      nodes:
        - id: Heat
          process: heat
          state: { plate: { from: inputs.plate } }
          bind: { minutes: { value: 2.5 } }
      returns:
        plate: { from: Heat.plate }
        label: { value: "heated" }
`;

describe("a literal", () => {
  const wf = readWorkflowText(workflow(HEAT));
  const graph = buildGraph(wf);
  const heat = findNode(graph, "Heat")!;

  it("is read as a value, beside the bindings rather than among them", () => {
    expect(heat.literals).toEqual({ minutes: 2.5 });
    expect(Object.keys(heat.bindings)).toEqual(["plate"]);
    expect(graph.returnLiterals).toEqual({ label: "heated" });
    expect(graph.returns).toEqual({ plate: ["Heat.plate"] });
  });

  it("draws no connection, having no source", () => {
    const { edges } = layoutGraph(graph, new Set());
    expect(edges.map((e) => `${e.fromKey}.${e.fromPort}>${e.toKey}.${e.toPort}`).sort()).toEqual([
      ".plate>Heat.plate",
      "Heat.plate>.plate",
    ]);
  });

  it("is shown with its port in the node's panel", () => {
    expect(renderNodeDetail(graph, "Heat")).toContain("minutes = 2.5");
    expect(renderNodeDetail(graph, "")).toContain("label = &quot;heated&quot;");
  });
});

describe("a source entry that is not exactly one of `from` and `value`", () => {
  const fails = (main: string): string => {
    try {
      readWorkflowText(workflow(main));
    } catch (e) {
      if (e instanceof ReadError) return e.message;
      throw e;
    }
    throw new Error("read without complaint");
  };
  const body = (bind: string, state = "{ plate: { from: inputs.plate } }") => `
    body:
      nodes:
        - id: Heat
          process: heat
          state: ${state}
          bind: ${bind}
      returns: { plate: { from: Heat.plate } }
`;

  it("names both, or neither (2.6.6)", () => {
    expect(fails(body(`{ minutes: { from: inputs.x, value: 1 } }`))).toMatch(/exactly one of `from` or `value`.*got both/);
    expect(fails(body(`{ minutes: {} }`))).toMatch(/exactly one of `from` or `value`.*got neither/);
  });

  it("refuses a literal where an Object is bound (11.1.1)", () => {
    expect(fails(body(`{ minutes: { value: 1 } }`, `{ plate: { value: 1 } }`))).toMatch(
      /cannot be bound to an Object-bearing port/,
    );
  });
});
