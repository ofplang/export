/**
 * The workflow as a tree of node invocations.
 *
 * This is the *source* structure, not the expanded one (design.md D11): a
 * composite is one box until someone opens it, and it says how many atomic
 * steps are inside. Twenty copies of the same unit read as "×20", which is
 * what a person wants when the plan is being explained to them; the way down
 * to the individual copies stays one click away.
 *
 * Structured nodes (workflow spec §17-§20) are drawn as the one node they
 * are. A `map`, `fold` or `do_while` over a composite opens onto its body, as
 * a composite does — one invocation's worth, which every invocation in the
 * plan is. A `branch` opens onto its two arms side by side, each the process
 * it names (`@then`, `@else` in the graph's paths: a step the plan never
 * writes, so no node id can take it). A plan path names an invocation; the
 * box that stands for it drops the position (`sourcePath`).
 */

import { GATE_OUT, isGatePath, jobScoped, pathKey, sourcePath, type ArcRef, type NodePath } from "./common";
import type { Scene } from "./scene";
import { armsOf, nodePorts } from "./structure";
import type { NodeInvocation, NodeKind, Workflow } from "./workflow";

export interface Binding {
  /** `"<sibling>.<port>"` or `"inputs.<port>"`. */
  readonly from: string;
  /** True for an Object-bearing binding (`state`), false for Pure Data. */
  readonly object: boolean;
}

/** What a box is in the workflow: a node's `kind`, an arm of a branch, or the entry. */
export type Structure = NodeKind | "arm";

/** The step a branch's arm adds to a graph path. Never in a plan path. */
export const ARM_STEP = { then: "@then", else: "@else" } as const;

export interface GraphNode {
  /** The invocation's own id; empty for the entry composite; `@then` / `@else` for an arm. */
  readonly id: string;
  readonly path: NodePath;
  readonly key: string;
  /** The process it invokes; for a branch the empty string, for an omitted `else` too. */
  readonly process: string;
  /** How it is laid out: a box, or a container that opens. */
  readonly kind: "atomic" | "composite";
  readonly structure: Structure;
  /** For an arm, which; for a branch, where its condition comes from. */
  readonly arm?: "then" | "else";
  readonly condition?: string;
  /** `do_while`: its `max_iterations`, as written. */
  readonly limit?: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** Declared type of each port, as written (`Plate`, `Float`, `Float[s]`), as the node exposes it. */
  readonly inputTypes: Readonly<Record<string, string>>;
  readonly outputTypes: Readonly<Record<string, string>>;
  /** This node's own inbound bindings, by the port they land on. */
  readonly bindings: Readonly<Record<string, Binding>>;
  /** Inputs given a literal value instead of a binding (workflow spec 11.1.1). */
  readonly literals: Readonly<Record<string, unknown>>;
  /** A composite's outputs returned as a literal (2.6.6). */
  readonly returnLiterals: Readonly<Record<string, unknown>>;
  /**
   * A container's outputs, by the child ports each is returned from — one,
   * or for a branch one per arm.
   */
  readonly returns: Readonly<Record<string, readonly string[]>>;
  /** Whether each returned output carries an Object, from its declared type. */
  readonly returnsObject: Readonly<Record<string, boolean>>;
  readonly children: readonly GraphNode[];
  /** Atomic steps at or below this node — the badge on a closed composite. */
  readonly atomicCount: number;
}

/** The port a branch's condition arrives on, drawn so the dependency shows. */
export const CONDITION_PORT = "condition";

export function buildGraph(wf: Workflow): GraphNode {
  const typesOf = (ports: Readonly<Record<string, { type: string }>> | undefined) =>
    Object.fromEntries(Object.entries(ports ?? {}).map(([p, d]) => [p, d.type]));

  /** A box for one process at `path`: a leaf, or a container opening onto its body. */
  const make = (
    path: NodePath,
    id: string,
    process: string,
    structure: Structure,
    bindings: Record<string, Binding>,
    literals: Readonly<Record<string, unknown>>,
    ports?: { inputs: Record<string, string>; outputs: Record<string, string> },
    extra: Partial<Pick<GraphNode, "arm" | "condition" | "limit">> = {},
  ): GraphNode => {
    const def = wf.processes[process];
    const inputTypes = ports?.inputs ?? typesOf(def?.inputs);
    const outputTypes = ports?.outputs ?? typesOf(def?.outputs);
    const inputs = Object.keys(inputTypes);
    const outputs = Object.keys(outputTypes);
    const base = { id, path, key: pathKey(path), process, structure, inputs, outputs, inputTypes, outputTypes, bindings, literals, ...extra };

    if (!def || def.kind === "atomic") {
      return { ...base, kind: "atomic", returnLiterals: {}, returns: {}, returnsObject: {}, children: [], atomicCount: 1 };
    }

    const children = def.body.nodes.map((inv) => child(path.concat(inv.id), inv));
    // A structured node exposes what its kind shapes (§17-§21); the body
    // returns more than that where an output is dropped.
    const returns: Record<string, string[]> = {};
    const returnsObject: Record<string, boolean> = {};
    for (const [port, src] of Object.entries(def.body.returns)) {
      if (!(port in outputTypes)) continue;
      returns[port] = [src.from];
      // `returns` does not split Object from Pure Data the way a node's
      // `state` / `data` does, so the declared type decides. An output whose
      // type is unknown stays an Object, as it was drawn before types were read.
      const type = outputTypes[port];
      returnsObject[port] = type === undefined || type === "" ? true : carriesObject(type, wf);
    }

    return {
      ...base, kind: "composite",
      returnLiterals: def.body.returnLiterals, returns, returnsObject, children,
      atomicCount: children.reduce((n, c) => n + c.atomicCount, 0),
    };
  };

  /** One node of a body, as its kind draws it. */
  const child = (path: NodePath, inv: NodeInvocation): GraphNode => {
    const ports = nodePorts(wf, inv);
    const b: Record<string, Binding> = {};
    const objectPort = (port: string): boolean => carriesObject(ports.inputs[port] ?? "", wf);
    for (const [port, src] of Object.entries(inv.state)) b[port] = { from: src.from, object: true };
    for (const [port, src] of Object.entries(inv.data)) b[port] = { from: src.from, object: false };
    for (const section of [inv.each, inv.carry, inv.args])
      for (const [port, src] of Object.entries(section)) b[port] = { from: src.from, object: objectPort(port) };

    if (inv.kind !== "branch") {
      const limit = inv.maxIterations
        ? inv.maxIterations.from ?? String(inv.maxIterations.value)
        : undefined;
      return make(path, inv.id, inv.process, inv.kind, b, inv.literals, ports, limit !== undefined ? { limit } : {});
    }
    return branch(path, inv, b, ports);
  };

  /** A branch: a container whose children are its two arms (§20). */
  const branch = (
    path: NodePath,
    inv: NodeInvocation,
    bindings: Record<string, Binding>,
    ports: { inputs: Record<string, string>; outputs: Record<string, string> },
  ): GraphNode => {
    const inputTypes = { ...ports.inputs };
    if (inv.condition?.from && !(CONDITION_PORT in inputTypes)) {
      inputTypes[CONDITION_PORT] = "Bool";
      bindings = { ...bindings, [CONDITION_PORT]: { from: inv.condition.from, object: false } };
    }
    const armBindings = (): Record<string, Binding> =>
      Object.fromEntries(
        Object.keys(inv.args).map((p) => [p, { from: `inputs.${p}`, object: carriesObject(ports.inputs[p] ?? "", wf) }]),
      );
    const arms: GraphNode[] = armsOf(inv).map(({ arm, process }) =>
      make(path.concat(ARM_STEP[arm]), ARM_STEP[arm], process, "arm", armBindings(), {}, undefined, { arm }),
    );
    if (!inv.arms?.else) {
      // An omitted `else` is the identity arm (§20): each Object-bearing
      // argument comes back as itself. Drawn so, with nothing inside.
      const through = Object.fromEntries(
        Object.entries(ports.inputs).filter(([p, t]) => p in ports.outputs && carriesObject(t, wf)),
      );
      arms.push({
        id: ARM_STEP.else, path: path.concat(ARM_STEP.else), key: pathKey(path.concat(ARM_STEP.else)),
        process: "", kind: "atomic", structure: "arm", arm: "else",
        inputs: Object.keys(through), outputs: Object.keys(through), inputTypes: through, outputTypes: through,
        bindings: Object.fromEntries(Object.keys(through).map((p) => [p, { from: `inputs.${p}`, object: true }])),
        literals: {}, returnLiterals: {}, returns: {}, returnsObject: {}, children: [], atomicCount: 0,
      });
    }
    const returns: Record<string, string[]> = {};
    const returnsObject: Record<string, boolean> = {};
    for (const [port, type] of Object.entries(ports.outputs)) {
      returns[port] = arms.filter((a) => a.outputs.includes(port)).map((a) => `${a.id}.${port}`);
      returnsObject[port] = carriesObject(type, wf);
    }
    return {
      id: inv.id, path, key: pathKey(path), process: "", kind: "composite", structure: "branch",
      ...(inv.condition?.from ? { condition: inv.condition.from } : {}),
      inputs: Object.keys(inputTypes), outputs: Object.keys(ports.outputs), inputTypes, outputTypes: ports.outputs,
      bindings, literals: inv.literals, returnLiterals: {}, returns, returnsObject, children: arms,
      atomicCount: arms.reduce((n, c) => n + c.atomicCount, 0),
    };
  };

  return make([], wf.entry, wf.entry, "invoke", {}, {});
}

/**
 * Whether a declared type carries an Object: it names a type the workflow
 * declares with `domain: object` (workflow spec: `types`). Built-in primitives
 * (`Int`, `Float`, `String`, …) are Pure Data; so is anything the workflow does
 * not declare. `Array<Plate>` carries Plates, so it counts. A unit suffix
 * (`Float[mg/mL]`) is dropped first: a unit atom may share a type's name.
 */
export function carriesObject(type: string, wf: Pick<Workflow, "types">): boolean {
  const names = type.replace(/\[[^\]]*\]/g, "").match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return names.some((name) => wf.types[name]?.domain === "object");
}

/** Find a node by its index key. */
export function findNode(root: GraphNode, key: string): GraphNode | undefined {
  if (root.key === key) return root;
  for (const child of root.children) {
    const hit = findNode(child, key);
    if (hit) return hit;
  }
  return undefined;
}

/** Every container below the root — what "expand all" opens. */
export function compositeKeys(root: GraphNode): string[] {
  const out: string[] = [];
  const walk = (n: GraphNode): void => {
    if (n.kind === "composite" && n.key !== "") out.push(n.key);
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}

/**
 * The graph nodes a plan path runs through, outermost first, ending at the
 * deepest one it names. Positions are dropped; a gate's path ends at its
 * region. In a branch, the arm is the one whose body holds the next node, or
 * — where the path ends at the branch, as an atomic arm's does — the one that
 * runs `process`. Where that cannot be told, the walk stops at the branch.
 */
export function graphTrail(root: GraphNode, path: NodePath, process?: string): GraphNode[] {
  const ids = sourcePath(path);
  const trail: GraphNode[] = [root];
  let node = root;
  for (let i = 0; i < ids.length; i++) {
    const next = node.children.find((c) => c.id === ids[i]);
    if (!next) break;
    trail.push(next);
    node = next;
    if (next.structure !== "branch") continue;
    const into = ids[i + 1];
    const arms = next.children;
    // A graph path names its arm (`@then`); a plan path never does.
    const named = arms.find((a) => a.id === into);
    if (named) {
      trail.push(named);
      node = named;
      i++;
      continue;
    }
    const arm =
      into !== undefined
        ? onlyOne(arms.filter((a) => a.children.some((c) => c.id === into)))
        : process !== undefined && !isGatePath(path)
          ? onlyOne(arms.filter((a) => a.kind === "atomic" && a.process === process))
          : undefined;
    if (!arm) break;
    trail.push(arm);
    node = arm;
  }
  return trail;
}

const onlyOne = <T>(xs: readonly T[]): T | undefined => (xs.length === 1 ? xs[0] : undefined);

/**
 * The box that stands for a node path on screen.
 *
 * A path into a closed container is represented by that container, which is
 * what makes the highlight work at any depth: the plan always names the atomic
 * node, and the graph may be showing its grandparent.
 */
export function visibleFor(
  root: GraphNode,
  path: NodePath,
  expanded: ReadonlySet<string>,
  process?: string,
): string | undefined {
  const isOpen = (n: GraphNode): boolean => n.kind === "composite" && (n.key === "" || expanded.has(n.key));
  const trail = graphTrail(root, path, process);
  for (let i = 0; i < trail.length - 1; i++) if (!isOpen(trail[i]!)) return trail[i]!.key;
  return trail[trail.length - 1]!.key;
}

/** The keys of every box between the root and the one a path names, exclusive. */
export function ancestorKeys(root: GraphNode, path: NodePath, process?: string): string[] {
  return graphTrail(root, path, process)
    .slice(1, -1)
    .map((n) => n.key);
}

/** What runs at one end of an arc: the step at that exact path, in that job, if the plan has one. */
export function processAt(scene: Scene, path: NodePath, job?: string): string | undefined {
  const at = scene.byNode.get(jobScoped(job, pathKey(path)));
  const a = at?.length === 1 ? scene.activities[at[0]!] : undefined;
  return a?.kind === "processing" ? a.process : undefined;
}

/**
 * Every activity a box accounts for — what selecting it lights, and what its
 * details count. A box stands for every activity whose path runs through it
 * (`graphTrail`): a step's, a decision's, a gate's or a reservation's own path,
 * either end of a move's arc. So a closed container stands for all of its
 * descendants (D11), a structured node for every one of its invocations, and
 * a branch's arm for only what ran in that arm. With `job`, only that job's.
 */
export function activitiesOn(scene: Scene, root: GraphNode, key: string, job?: string): number[] {
  if (key === "")
    return scene.activities.flatMap((a, i) => (a.kind === "replenishment" || (job !== undefined && a.job !== job) ? [] : [i]));
  const through = (path: NodePath, process?: string): boolean =>
    path.length > 0 && graphTrail(root, path, process).some((n) => n.key === key);
  const out: number[] = [];
  scene.activities.forEach((a, i) => {
    if (job !== undefined && a.job !== job) return;
    switch (a.kind) {
      case "replenishment":
        return;
      case "processing":
        if (through(a.node, a.process)) out.push(i);
        return;
      case "transport":
      case "relay":
        if (through(a.arc.from.node, processAt(scene, a.arc.from.node, a.job)) || through(a.arc.to.node, processAt(scene, a.arc.to.node, a.job)))
          out.push(i);
        return;
      default:
        if (through(a.node)) out.push(i);
    }
  });
  return out;
}

/** `arcRoute` for a move of the plan, with what runs at either end, in its job, looked up. */
export function moveRoute(scene: Scene, root: GraphNode, arc: ArcRef, job?: string): EdgeId[] | undefined {
  const from = processAt(scene, arc.from.node, job);
  const to = processAt(scene, arc.to.node, job);
  return arcRoute(root, arc, { ...(from ? { from } : {}), ...(to ? { to } : {}) });
}

/**
 * One drawn connection, as the graph names it: a binding or a return between
 * two boxes, each end the box's key and one of its ports. A container's own
 * border is its key too — an edge from its input, or back out to its output.
 */
export interface EdgeId {
  readonly fromKey: string;
  readonly fromPort: string;
  readonly toKey: string;
  readonly toPort: string;
}

export const edgeKey = (e: EdgeId): string => `${e.fromKey}|${e.fromPort}>${e.toKey}|${e.toPort}`;

/** The port a gate's path names, after `"@out"` (§6.3). */
const gatePort = (path: NodePath): string => String(path[path.indexOf(GATE_OUT) + 1]);

/**
 * The connections a plan arc runs along, at every level of nesting.
 *
 * A plan arc joins two atomic steps, or a step and a gate (§6.4, §6.15); the
 * graph draws the bindings that get it there — out of a container by its
 * `returns`, across a body by a sibling binding, into a container by its
 * `inputs.` binding. Which of them are on screen depends on what is open, so
 * all of them are returned and the view lights the ones it draws. Undefined
 * if the workflow does not lead from one end to the other: the arc is then
 * not this workflow's.
 *
 * A gate is where its region hands an outcome on: an arc into one ends at the
 * region's output, an arc out of one starts there. Out of a loop's gate into
 * its own next invocation, or round a fold's carry, the Object goes back in
 * by the input of the same name. `process` names what runs at either end
 * where the arc meets a branch's atomic arm.
 */
export function arcRoute(
  root: GraphNode,
  arc: ArcRef,
  process: { from?: string; to?: string } = {},
): EdgeId[] | undefined {
  const parents = new Map<string, GraphNode>();
  const walk = (n: GraphNode): void => {
    for (const c of n.children) {
      parents.set(c.key, n);
      walk(c);
    }
  };
  walk(root);
  const under = (n: GraphNode, of: GraphNode): boolean => n.key === of.key || (of.key === "" ? true : n.key.startsWith(`${of.key}.`));

  // Where it ends: an atomic step's input, a region's output (a gate), or the interface.
  type End = { node: GraphNode; port: string; side: "in" | "out" };
  const endOf = (path: NodePath, port: string, proc: string | undefined, side: "in" | "out"): End | undefined => {
    if (path.length === 0) return { node: root, port, side: side === "in" ? "out" : "in" };
    const trail = graphTrail(root, path, proc);
    const node = trail[trail.length - 1]!;
    if (isGatePath(path)) return { node, port: gatePort(path), side: "out" };
    return node.kind === "atomic" || node.structure === "branch" ? { node, port, side } : undefined;
  };
  const target = endOf(arc.to.node, arc.to.port, process.to, "in");
  const start = endOf(arc.from.node, arc.from.port, process.from, "out");
  if (!target || !start) return undefined;
  // From one invocation of a box to the next of the same box — a fold's or a
  // loop's carry round an atomic target: inside the one box, along nothing drawn.
  if (start.node === target.node && start.node !== root && (start.node.structure === "fold" || start.node.structure === "do_while"))
    return [];

  const route: EdgeId[] = [];
  let container: GraphNode;
  let from: GraphNode;
  let port = start.port;
  if (start.node === root) {
    container = from = root;
  } else if (isGatePath(arc.from.node) && target.node !== start.node && under(target.node, start.node)) {
    // Out of a region's gate into the region again: its next invocation.
    container = from = start.node;
  } else {
    const parent = parents.get(start.node.key);
    if (!parent) return undefined;
    container = parent;
    from = start.node;
  }

  const reached = (node: GraphNode, p: string, side: "in" | "out"): boolean =>
    node.key === target.node.key && p === target.port && side === target.side;

  // Each step moves one binding; a workflow is finite, so is the route.
  for (let guard = 0; guard < 1000; guard++) {
    const source = from === container ? `inputs.${port}` : `${from.id}.${port}`;
    const candidates = container.children.filter((c) =>
      Object.values(c.bindings).some((b) => b.object && b.from === source),
    );
    // Into a branch, both arms take the argument: the one the target is in.
    const next =
      container.structure === "branch" && candidates.length > 1
        ? onlyOne(candidates.filter((c) => under(target.node, c))) ?? onlyOne(candidates.filter((c) => c.process === ""))
        : candidates[0];
    if (next) {
      const toPort = Object.entries(next.bindings).find(([, b]) => b.object && b.from === source)![0];
      route.push({ fromKey: from.key, fromPort: port, toKey: next.key, toPort });
      if (reached(next, toPort, "in")) return route;
      if (next.kind === "atomic") {
        // The identity arm hands its argument straight back (§20).
        if (next.structure === "arm" && next.process === "") {
          from = next;
          port = toPort;
          continue;
        }
        return undefined;
      }
      container = from = next;
      port = toPort;
      continue;
    }
    const out =
      from === container
        ? undefined
        : Object.entries(container.returns).find(([, srcs]) => srcs.includes(source))?.[0];
    if (out === undefined) return undefined;
    route.push({ fromKey: from.key, fromPort: port, toKey: container.key, toPort: out });
    if (reached(container, out, "out")) return route;
    if (container === root) return undefined;
    // Round a fold's or a loop's carry, into the next invocation of the same node.
    if ((container.structure === "fold" || container.structure === "do_while") && under(target.node, container) && container.inputs.includes(out)) {
      from = container;
      port = out;
      continue;
    }
    from = container;
    container = parents.get(container.key)!;
    port = out;
  }
  return undefined;
}
