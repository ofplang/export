/**
 * Unit test for the feature gate.
 *
 * The golden test only ever feeds it documents that pass, so a gate hard-wired
 * to `supported: true` would sail through it. These are the negative cases:
 * one per construct the viewer refuses, plus the two ways a document can look
 * unsupported without being so.
 */

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import { gateSummary, gateWorkflow } from "../src/read";

const gate = (yaml: string) => gateWorkflow(parseYaml(yaml));

const PLAIN = `
spec_version: "0.0"
types:
  Plate: { domain: object }
processes:
  heat:
    kind: atomic
    inputs:  { plate: { type: Plate, phase: data } }
    outputs: { out:   { type: Plate, phase: data } }
  main:
    kind: composite
    inputs:  { sample: { type: Plate, phase: data } }
    outputs: { result: { type: Plate, phase: data } }
    body:
      nodes:
        - id: Heat
          process: heat
          state: { plate: { from: inputs.sample } }
      returns:
        result: { from: Heat.out }
entry: main
`;

describe("a plain v0 workflow", () => {
  it("is supported, with nothing derived and no banner", () => {
    const r = gate(PLAIN);
    expect(r.supported).toBe(true);
    expect(r.derived).toEqual([]);
    expect(r.findings).toEqual([]);
    expect(r.needsExpansion).toBe(false);
    expect(gateSummary(r)).toBe("");
  });
});

describe("$import", () => {
  it("is refused, and asks for expansion rather than listing features", () => {
    const r = gate(`
spec_version: "0.0"
processes:
  $import: ./library.yaml
entry: main
`);
    expect(r.supported).toBe(false);
    expect(r.needsExpansion).toBe(true);
    expect(r.findings[0]?.at).toBe("processes.$import");
    expect(gateSummary(r)).toMatch(/Expand it first/);
  });

  it("is found however deep it sits (§3.2)", () => {
    const r = gate(`
processes:
  main:
    kind: composite
    body:
      nodes:
        - $import: ./node.yaml
      returns: {}
entry: main
`);
    expect(r.needsExpansion).toBe(true);
    expect(r.findings[0]?.at).toBe("processes.main.body.nodes[0].$import");
  });
});

describe("structured nodes", () => {
  const withKind = (kind: string) => `
processes:
  main:
    kind: composite
    body:
      nodes:
        - id: n
          kind: ${kind}
          process: p
      returns: {}
entry: main
`;

  it.each([
    ["map", "node_map"],
    ["fold", "node_fold"],
    ["do_while", "node_do_while"],
    ["branch", "node_branch"],
  ])("`kind: %s` derives %s", (kind, feature) => {
    const r = gate(withKind(kind));
    expect(r.supported).toBe(false);
    expect(r.derived).toEqual([feature]);
    expect(r.findings[0]?.at).toBe("processes.main.body.nodes[0]");
  });

  it("an unrecognised kind is refused rather than guessed at", () => {
    const r = gate(withKind("scatter"));
    expect(r.supported).toBe(false);
    expect(r.derived).toEqual([]); // not a v0 feature, so nothing is derived
    expect(r.findings[0]?.what).toMatch(/unrecognised node kind/);
  });
});

describe("process-level features", () => {
  it("`type_params` derives generic_processes (§8)", () => {
    const r = gate(`
processes:
  wash:
    kind: atomic
    type_params: { O: { domain: object } }
entry: wash
`);
    expect(r.derived).toEqual(["generic_processes"]);
    expect(r.findings[0]?.at).toBe("processes.wash.type_params");
  });

  it("`script` derives python_script_processes (§22)", () => {
    const r = gate(`
processes:
  add:
    kind: atomic
    script: { language: python, code: "return {}" }
entry: add
`);
    expect(r.derived).toEqual(["python_script_processes"]);
  });

  it("reports several at once, sorted", () => {
    const r = gate(`
processes:
  a:
    kind: atomic
    script: { language: python, code: "" }
  b:
    kind: atomic
    type_params: { T: { domain: data } }
entry: a
`);
    expect(r.derived).toEqual(["generic_processes", "python_script_processes"]);
    expect(r.findings).toHaveLength(2);
  });
});

describe("what the document declares is not what it requires (§4.1)", () => {
  it("over-declaring does not make a renderable document unsupported", () => {
    const r = gate(PLAIN.replace('spec_version: "0.0"', 'spec_version: "0.0"\nfeatures: [node_map]'));
    expect(r.declared).toEqual(["node_map"]);
    expect(r.derived).toEqual([]);
    expect(r.supported).toBe(true);
  });

  it("under-declaring does not make an unsupported document renderable", () => {
    const r = gate(`
features: []
processes:
  main:
    kind: composite
    body:
      nodes: [{ id: n, kind: map, process: p }]
      returns: {}
entry: main
`);
    expect(r.declared).toEqual([]);
    expect(r.derived).toEqual(["node_map"]);
    expect(r.supported).toBe(false);
  });
});

describe("robustness", () => {
  it("never throws on a malformed document — that is the reader's job to report", () => {
    for (const junk of ["", "[]", "42", "processes: 7", "processes: { a: null }", "null"]) {
      expect(() => gate(junk)).not.toThrow();
    }
  });
});
