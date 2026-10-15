/**
 * Whether a plan of several jobs (§6.11) can be drawn against one workflow.
 *
 * Every view that joins the plan to the graph assumes one workflow: one
 * graph, one namespace of node paths. A plan of several jobs is that only
 * where every job runs the same workflow — said by its `meta`, where every
 * job names the same file, or shown by the plan itself, where every one of
 * its activities joins to the workflow given. A plan that does neither is
 * drawn on its own, and says why (design.md D75): pairing a job's activity
 * with another workflow's box would light the wrong box.
 */

import { GATE_OUT, isBoundary, isGatePath, pathText, type PortRef } from "./common";
import type { ExecutionDocument } from "./document";
import { nodePorts, resolvePath } from "./structure";
import type { Workflow } from "./workflow";

/** Undefined where the jobs can be drawn against `wf`; otherwise why not. */
export function whyNotOneWorkflow(doc: ExecutionDocument, wf: Workflow): string | undefined {
  if (!doc.jobs?.length) return undefined;
  const named = [...new Set(doc.meta?.workflows ?? [])].filter((w) => w !== "<in-memory>");
  if (named.length > 1) return `its jobs run ${named.length} different workflows (${named.join(", ")})`;

  // Shown by the plan: every step is a step of this workflow, running the
  // process it says ran, and every move joins two of its ports.
  const portOf = (e: PortRef): boolean => {
    if (isBoundary(e)) return true;
    const hit = resolvePath(wf, e.node);
    if (!hit) return false;
    if (isGatePath(e.node)) return String(e.node[e.node.indexOf(GATE_OUT) + 1]) in nodePorts(wf, hit.invocation).outputs;
    return hit.def !== undefined;
  };
  for (const a of doc.activities) {
    const job = a.job ?? "a job";
    if (a.kind === "processing") {
      const hit = resolvePath(wf, a.node, a.process);
      if (!hit || hit.process !== a.process || hit.def?.kind !== "atomic")
        return `${job} runs ${a.process} at ${pathText(a.node)}, which is not a step of this workflow`;
    } else if (a.kind === "transport" || a.kind === "relay") {
      for (const end of [a.arc.from, a.arc.to])
        if (!portOf(end)) return `${job} moves an Object at ${pathText(end.node)}, which this workflow does not have`;
    }
  }
  return undefined;
}
