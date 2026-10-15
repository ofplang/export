/**
 * Golden test — every workflow the pinned submodule ships must read, and must
 * pass the feature gate.
 *
 * The gate assertion is the load-bearing one. It says the corpus stays inside
 * the subset this viewer draws — structured nodes included; the day an
 * example starts using `$import` or a generic, raising the pin turns this red
 * and the gate (design.md D10) has to earn its keep for real.
 */

import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import { armsOf, nodePorts } from "../../src/model/structure";
import { gateSummary, gateWorkflow, readWorkflowText } from "../../src/read";
import { SUPPORTED_FEATURES } from "../../src/read/gate";
import { read, workflowFiles } from "./corpus";

it("the pinned submodule ships workflows", () => {
  expect(workflowFiles.length).toBeGreaterThanOrEqual(5);
});

for (const [dir, name] of workflowFiles)
  describe(name, () => {
    const text = read(dir, name);
    const wf = readWorkflowText(text);

    it("reads, and its entry resolves to a declared process", () => {
      expect(wf.entry).not.toBe("");
      expect(wf.processes[wf.entry]).toBeDefined();
    });

    it("passes the feature gate", () => {
      // The gate takes the raw parsed document, not the model — it has to see
      // the keys the model deliberately drops.
      const report = gateWorkflow(parseYaml(text));
      expect(gateSummary(report)).toBe("");
      expect(report.supported).toBe(true);
      expect(report.needsExpansion).toBe(false);
      for (const f of report.derived) expect(SUPPORTED_FEATURES).toContain(f);
    });

    it("every node invokes a declared process", () => {
      for (const [pname, def] of Object.entries(wf.processes)) {
        if (def.kind !== "composite") continue;
        for (const node of def.body.nodes) {
          // A branch names a process per arm instead (workflow spec 21.0).
          const invoked = node.kind === "branch" ? armsOf(node).map((a) => a.process) : [node.process];
          for (const name of invoked) expect(wf.processes[name], `${pname}/${node.id} -> ${name}`).toBeDefined();
        }
      }
    });

    it("every binding names a sibling node's output or one of the container's inputs", () => {
      for (const [pname, def] of Object.entries(wf.processes)) {
        if (def.kind !== "composite") continue;
        const byId = new Map(def.body.nodes.map((n) => [n.id, n]));

        const check = (from: string, where: string): void => {
          const dot = from.indexOf(".");
          expect(dot, `${where}: "${from}" has no port half`).toBeGreaterThan(0);
          const head = from.slice(0, dot);
          const port = from.slice(dot + 1);

          if (head === "inputs") {
            expect(def.inputs[port], `${where}: ${pname} has no input ${port}`).toBeDefined();
            return;
          }
          const src = byId.get(head);
          expect(src, `${where}: no sibling node "${head}"`).toBeDefined();
          // What a node exposes, shaped by its kind (§17-§21): a map's outputs
          // collected, a loop's `exhausted`, a branch's common outputs.
          expect(
            nodePorts(wf, src!).outputs[port],
            `${where}: ${src!.id} has no output ${port}`,
          ).toBeDefined();
        };

        for (const node of def.body.nodes) {
          for (const [port, b] of Object.entries({ ...node.state, ...node.data, ...node.each, ...node.carry, ...node.args }))
            check(b.from, `${pname}/${node.id}.${port}`);
          if (node.kind === "branch" && node.condition?.from) check(node.condition.from, `${pname}/${node.id}.condition`);
        }
        for (const [port, b] of Object.entries(def.body.returns))
          check(b.from, `${pname}.returns.${port}`);
      }
    });
  });
