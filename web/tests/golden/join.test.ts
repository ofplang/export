/**
 * Golden test — a plan, its workflow and its environment agree.
 *
 * This is the one that protects the feature the viewer exists for. Linked
 * highlighting works by joining a planned activity back to the workflow node
 * it came from, through the `node` path (§6.3) and the arc endpoints (§6.4).
 * If that join is not total, the viewer lights up the wrong box — or nothing —
 * and no amount of care in the renderer fixes it.
 *
 * So: every activity in every complete triple must resolve, both ways.
 */

import { describe, expect, it } from "vitest";

import type { NodePath } from "../../src/model/common";
import { GATE_OUT, isGatePath, pathKey } from "../../src/model/common";
import { nodePorts, resolvePath } from "../../src/model/structure";
import type { ProcessDef, Workflow } from "../../src/model/workflow";
import { readEnvironmentText, readExecutionDocumentText, readWorkflowText } from "../../src/read";
import { read, triples } from "./corpus";

/**
 * Walk a node path from the entry composite down — through every invocation
 * of a structured node and into a branch's arms (`resolvePath`). The empty
 * path is the entry composite itself.
 */
function resolve(
  wf: Workflow,
  path: NodePath,
  process?: string,
): { process: string; def: ProcessDef } | undefined {
  if (path.length === 0) {
    const entry = wf.processes[wf.entry];
    return entry ? { process: wf.entry, def: entry } : undefined;
  }
  const hit = resolvePath(wf, path, process);
  return hit?.def ? { process: hit.process, def: hit.def } : undefined;
}

it("the corpus has complete workflow + environment + plan triples", () => {
  expect(triples.length).toBeGreaterThanOrEqual(4);
});

for (const t of triples)
  describe(t.name, () => {
    const wf = readWorkflowText(read(...t.workflow));
    const env = readEnvironmentText(read(...t.environment));
    const doc = readExecutionDocumentText(read(...t.plan));

    it("every processing activity resolves to the workflow node it names (§6.3)", () => {
      for (const a of doc.activities) {
        if (a.kind !== "processing") continue;
        const hit = resolve(wf, a.node, a.process);
        expect(hit, `${pathKey(a.node)} does not resolve`).toBeDefined();
        // The join the linked highlight depends on: the node the plan points at
        // must be an invocation of the process the plan says ran.
        expect(hit!.process, `${pathKey(a.node)}`).toBe(a.process);
        expect(hit!.def.kind, `${pathKey(a.node)} is not atomic`).toBe("atomic");
      }
    });

    it("every processing activity names a mode the environment declares (§5.5)", () => {
      for (const a of doc.activities) {
        if (a.kind !== "processing") continue;
        const capability = env.processes[a.process];
        expect(capability, `${a.process} has no capability in the environment`).toBeDefined();
        const ids = capability!.modes.map((m) => m.id);
        expect(ids, `${a.process} mode ${a.mode}`).toContain(a.mode);
      }
    });

    it("a processing activity's devices and spots match its chosen mode (§6.3)", () => {
      for (const a of doc.activities) {
        if (a.kind !== "processing") continue;
        const mode = env.processes[a.process]!.modes.find((m) => m.id === a.mode)!;
        expect([...(a.devices ?? [])].sort()).toEqual([...mode.devices].sort());
        for (const [port, spot] of Object.entries(a.inputSpots ?? {}))
          expect(mode.inputSpots[port], `${a.process}.${port}`).toBe(spot);
        for (const [port, spot] of Object.entries(a.outputSpots ?? {}))
          expect(mode.outputSpots[port], `${a.process}.${port}`).toBe(spot);
      }
    });

    it("every arc endpoint resolves, and names a port that exists (§6.4)", () => {
      for (const a of doc.activities) {
        if (a.kind !== "transport" && a.kind !== "relay") continue;
        for (const [side, end] of [
          ["from", a.arc.from],
          ["to", a.arc.to],
        ] as const) {
          if (isGatePath(end.node)) {
            // A gate's own ports are `in` and `out`; the port its path names
            // after "@out" is one its region exposes (§6.15).
            expect(["in", "out"], `${side} gate ${pathKey(end.node)}`).toContain(end.port);
            const region = resolvePath(wf, end.node);
            expect(region, `${side} gate ${pathKey(end.node)}: no region`).toBeDefined();
            const named = String(end.node[end.node.indexOf(GATE_OUT) + 1]);
            expect(Object.keys(nodePorts(wf, region!.invocation).outputs), `${pathKey(end.node)}`).toContain(named);
            continue;
          }
          const hit = resolve(wf, end.node);
          expect(hit, `${side} ${pathKey(end.node)} does not resolve`).toBeDefined();

          // A boundary endpoint is the entry composite itself: the `from` side
          // names one of the workflow's entry inputs, the `to` side a final
          // output. Interior endpoints are the other way round — an arc leaves
          // a node's output and enters another node's input.
          const boundary = end.node.length === 0;
          const ports =
            boundary === (side === "from") ? hit!.def.inputs : hit!.def.outputs;
          expect(
            ports[end.port],
            `${side} ${pathKey(end.node)}.${end.port} is not a port of ${hit!.process}`,
          ).toBeDefined();
        }
      }
    });

    it("every transport moves between spots the environment declares (§5.2)", () => {
      const spots = new Set(env.devices.flatMap((d) => d.spots.map((s) => `${d.id}.${s}`)));
      for (const a of doc.activities) {
        if (a.kind !== "transport") continue;
        expect(spots, a.fromSpot).toContain(a.fromSpot);
        expect(spots, a.toSpot).toContain(a.toSpot);
        if (a.transporter)
          expect(
            env.transporters.map((x) => x.id),
            a.transporter,
          ).toContain(a.transporter);
      }
    });
  });
