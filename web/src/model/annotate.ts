/**
 * What a plan says about the structured nodes of its workflow, for the graph.
 *
 * The graph draws each structured node once (design.md D11); the plan runs it
 * as many times as it runs it. Each box is told how many invocations it has
 * in this plan, and each arm of a branch how many of the branch's invocations
 * took it — and whether the plan stated that or only assumed it (§6.14).
 *
 * Everything is read off the document: an invocation is a position the plan
 * writes in a path; an arm is the one `expansion.arms` states, the one an
 * assumed decision names, or the one the steps that ran there are in. A branch
 * invocation none of those tells is counted for no arm.
 */

import { pathKey, sourcePath, type NodePath } from "./common";
import { graphTrail, processAt, type GraphNode } from "./graph";
import type { Scene } from "./scene";

export interface BoxNote {
  /** Invocations of a `map`, `fold` or `do_while` in this plan. */
  readonly invocations?: number;
  /** For an arm: the branch invocations the run stated it for, and those the plan assumes it for. */
  readonly ran?: number;
  readonly assumed?: number;
}

/**
 * The plan prefix that names one invocation of the node at source depth
 * `depth` (its id is the `depth`-th id of the path): up to its id, and its
 * position when it has one.
 */
function invocationOf(path: NodePath, depth: number): NodePath | undefined {
  let seen = 0;
  for (let i = 0; i < path.length; i++) {
    if (typeof path[i] !== "string") continue;
    if (++seen === depth) return typeof path[i + 1] === "number" ? path.slice(0, i + 2) : path.slice(0, i + 1);
  }
  return undefined;
}

export function annotate(scene: Scene, root: GraphNode): Map<string, BoxNote> {
  const out = new Map<string, BoxNote>();
  // Every path the plan writes, with what runs there.
  const paths: [NodePath, string | undefined][] = [];
  for (const a of scene.activities) {
    if (a.kind === "processing") paths.push([a.node, a.process]);
    else if (a.kind === "transport" || a.kind === "relay") {
      for (const end of [a.arc.from.node, a.arc.to.node]) if (end.length) paths.push([end, processAt(scene, end)]);
    } else if (a.kind !== "replenishment") paths.push([a.node, undefined]);
  }

  const visit = (n: GraphNode): void => {
    n.children.forEach(visit);
    if (n.key === "") return;
    const depth = sourcePath(n.path).filter((s) => !s.startsWith("@")).length;
    if (n.structure === "map" || n.structure === "fold" || n.structure === "do_while") {
      const seen = new Set<string>();
      for (const [p, process] of paths) {
        if (!graphTrail(root, p, process).some((g) => g.key === n.key)) continue;
        const inv = invocationOf(p, depth);
        if (inv && typeof inv[inv.length - 1] === "number") seen.add(pathKey(inv));
      }
      out.set(n.key, { invocations: seen.size });
    }
    if (n.structure !== "branch") return;

    // One entry per invocation of the branch: the arm, and whether it is stated.
    const arms = new Map<string, { arm: string; stated: boolean }>();
    for (const x of scene.doc.expansion?.arms ?? []) arms.set(pathKey(x.node), { arm: x.arm, stated: true });
    for (const a of scene.activities)
      if (a.kind === "decision" && (a.arm === "then" || a.arm === "else") && pathKey(sourcePath(a.node)) === pathKey(sourcePath(n.path)))
        if (!arms.has(pathKey(a.node)) || !a.assumed) arms.set(pathKey(a.node), { arm: a.arm, stated: !a.assumed });
    for (const [p, process] of paths) {
      const trail = graphTrail(root, p, process);
      const at = trail.findIndex((g) => g.key === n.key);
      const arm = at >= 0 ? trail[at + 1] : undefined;
      const inv = invocationOf(p, depth);
      if (!arm?.arm || !inv || arms.has(pathKey(inv))) continue;
      // Ran there with nothing stated or assumed: a literal condition the
      // scheduler read itself, or a stated arm whose decision has passed.
      arms.set(pathKey(inv), { arm: arm.arm, stated: true });
    }
    for (const arm of n.children) {
      if (!arm.arm) continue;
      let ran = 0;
      let assumed = 0;
      for (const v of arms.values())
        if (v.arm === arm.arm) {
          if (v.stated) ran++;
          else assumed++;
        }
      out.set(arm.key, { ran, assumed });
    }
  };
  visit(root);
  return out;
}
