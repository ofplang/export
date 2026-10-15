/**
 * Plans of several jobs (SPEC §6.11, design.md D75): read, drawn against one
 * workflow where every job runs it, and shown one job at a time on request.
 */

import { describe, expect, it } from "vitest";

import { ganttLayout } from "../src/layout/gantt";
import { whyNotOneWorkflow } from "../src/model/jobs";
import { traceObjects } from "../src/model/objects";
import { buildScene } from "../src/model/scene";
import { readEnvironmentText, readExecutionDocumentText, readWorkflowText } from "../src/read";
import { EXAMPLES, OUTPUTS, read } from "./golden/corpus";

const refill = () => {
  const doc = readExecutionDocumentText(read(OUTPUTS, "shared_refill.plan.yaml"));
  const wf = readWorkflowText(read(EXAMPLES, "shared_refill.workflow.yaml"));
  const env = readEnvironmentText(read(EXAMPLES, "consumable.env.yaml"));
  return { doc, wf, env, scene: buildScene(doc, env, wf) };
};

describe("one workflow for every job, or none (D75)", () => {
  it("is drawn against the workflow every job names", () => {
    const { doc, wf } = refill();
    expect(doc.meta?.workflows).toEqual(["examples/shared_refill.workflow.yaml", "examples/shared_refill.workflow.yaml"]);
    expect(whyNotOneWorkflow(doc, wf)).toBeUndefined();
  });

  it("is not, where the jobs name different workflows", () => {
    const { doc, wf } = refill();
    const two = { ...doc, meta: { workflows: ["a.workflow.yaml", "b.workflow.yaml"] } };
    expect(whyNotOneWorkflow(two, wf)).toMatch(/2 different workflows/);
  });

  it("is not, where a job runs a step the workflow given does not have", () => {
    const { doc } = refill();
    const other = readWorkflowText(read(EXAMPLES, "simple.workflow.yaml"));
    const unnamed = { ...doc, meta: { workflows: ["<in-memory>", "<in-memory>"] } };
    expect(whyNotOneWorkflow(unnamed, other)).toMatch(/^job1 runs .* not a step of this workflow$/);
  });

  it("a plan of one workflow is never in question", () => {
    const doc = readExecutionDocumentText(read(OUTPUTS, "simple.plan.yaml"));
    expect(whyNotOneWorkflow(doc, readWorkflowText(read(EXAMPLES, "storage.workflow.yaml")))).toBeUndefined();
  });
});

describe("each job's own", () => {
  it("indexes the same path once per job", () => {
    const { scene } = refill();
    expect(scene.jobs).toEqual(["job1", "job2"]);
    const keys = [...scene.byNode.keys()];
    expect(keys.filter((k) => k.endsWith(":Make"))).toEqual(["job1:Make", "job2:Make"]);
  });

  it("follows each job's Objects apart", () => {
    const { scene } = refill();
    const t = traceObjects(scene);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(new Set(t.traces.map((x) => x.job))).toEqual(new Set(["job1", "job2"]));
    expect(new Set(t.traces.map((x) => x.id)).size).toBe(t.traces.length);
    expect(t.traces[0]!.where).toMatch(/^job[12] · /);
  });
});

describe("shown together, or one at a time", () => {
  it("gives each job its own lanes in the flow view", () => {
    const { scene } = refill();
    const lanes = ganttLayout(scene, "flow").lanes.map((l) => l.label);
    expect(lanes.filter((l) => l.startsWith("job1 · ")).length).toBeGreaterThan(0);
    expect(lanes.filter((l) => l.startsWith("job2 · ")).length).toBeGreaterThan(0);
    // The refill serves both, so it is in neither's lanes.
    expect(lanes).toContain("refills");
  });

  it("shows one job alone, with the refill that serves it", () => {
    const { scene } = refill();
    const bars = ganttLayout(scene, "device", "job2").bars;
    const kinds = new Set(bars.map((b) => scene.activities[b.index!]!));
    for (const a of kinds) expect(a.kind === "replenishment" || a.job === "job2").toBe(true);
    expect([...kinds].some((a) => a.kind === "replenishment")).toBe(true);
    expect(ganttLayout(scene, "object", "job1").lanes.every((l) => l.label.startsWith("job1 · "))).toBe(true);
  });
});
