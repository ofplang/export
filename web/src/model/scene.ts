/**
 * The scene — one plan, indexed for drawing.
 *
 * Everything the views need is derived once, here. The indices are keyed the
 * way the specification already identifies things: an activity by its node
 * path (§6.3) and a move by its logical arc (§6.4). That is what makes linked
 * highlighting a lookup rather than a search, and it is why the join is worth
 * testing (`tests/golden/join.test.ts`).
 *
 * Activities are referred to by their position in `activities`, which is
 * document order. That index is the identity used by every view and by the
 * selection.
 */

import { arcKey, deviceOf, pathKey, sourcePath, type NodePath } from "./common";
import type { Activity, ExecutionDocument, ProcessingActivity } from "./document";
import type { Environment } from "./environment";
import type { Workflow } from "./workflow";

export type MachineKind = "device" | "transporter" | "replenisher";

export interface Machine {
  readonly id: string;
  readonly kind: MachineKind;
  /** Fraction of the horizon this machine is held, 0..1. */
  readonly occupancy: number;
}

/**
 * A consumable stock, replayed across the run.
 *
 * §4.7.2: `inventories` states the level at the *start*, and every later level
 * follows from the history. That replay is the only way to answer the question
 * a plan with refills in it raises — why this many, and why here.
 */
export interface ResourceTrace {
  /** `<device>.<resource>` (§8.2). */
  readonly ref: string;
  readonly capacity: number | undefined;
  readonly start: number;
  /**
   * The lowest level reached *after* something happened to the stock.
   *
   * Not counting the starting level: a stock that begins empty is empty at
   * time zero by definition, and saying so tells nobody anything. What is
   * worth knowing is how close the run came to running dry once it was under
   * way.
   */
  readonly low: number;
  readonly end: number;
  readonly refills: number;
  readonly consumed: number;
}

export interface Metrics {
  readonly makespan: number;
  readonly horizon: number;
  readonly counts: Readonly<Record<Activity["kind"], number>>;
  readonly busiest: readonly Machine[];
}

export interface Scene {
  readonly doc: ExecutionDocument;
  readonly env: Environment | undefined;
  readonly workflow: Workflow | undefined;

  readonly unit: string;
  readonly activities: readonly Activity[];

  /** node path → indices of the processing activities at that exact node. */
  readonly byNode: ReadonlyMap<string, readonly number[]>;
  /** logical arc → indices of its legs and junctions, in travel order. */
  readonly byArc: ReadonlyMap<string, readonly number[]>;
  /** machine id → indices of everything that holds it, or rests on it (§4.4.2). */
  readonly byMachine: ReadonlyMap<string, readonly number[]>;
  /**
   * The work that stands on an outcome the plan only assumes (§6.14): what
   * runs inside a branch's assumed arm, or in the one invocation a traversal
   * of a length not yet counted is planned on. It may not happen at all.
   * A loop assumed to end has nothing of the kind — its invocations so far
   * happen whatever the decision says.
   */
  readonly assumed: ReadonlySet<number>;

  readonly machines: readonly Machine[];
  readonly resources: readonly ResourceTrace[];
  readonly metrics: Metrics;
}

export function buildScene(
  doc: ExecutionDocument,
  env?: Environment,
  workflow?: Workflow,
): Scene {
  const activities = doc.activities;
  const horizon = activities.reduce((m, a) => Math.max(m, a.end), 0);
  const makespan = scalarObjective(doc) ?? horizon;

  const byNode = new Map<string, number[]>();
  const byArc = new Map<string, number[]>();
  const byMachine = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, k: string, i: number): void => {
    const list = m.get(k);
    if (list) list.push(i);
    else m.set(k, [i]);
  };

  const spans = new Map<string, [number, number][]>();
  const hold = (id: string | undefined, i: number, a: Activity): void => {
    if (!id) return;
    push(byMachine, id, i);
    const list = spans.get(id);
    if (list) list.push([a.start, a.end]);
    else spans.set(id, [[a.start, a.end]]);
  };

  activities.forEach((a, i) => {
    switch (a.kind) {
      case "processing":
        push(byNode, pathKey(a.node), i);
        // A step that only rests on its devices is still *on* them, so it is
        // indexed there, but it holds none of them (§4.4.2).
        for (const d of holdingDevices(a, env))
          if (accessesDevices(a, env)) hold(d, i, a);
          else push(byMachine, d, i);
        break;
      case "transport":
        push(byArc, arcKey(a.arc), i);
        // A transport holds its transporter and both end devices (§4.5).
        hold(a.transporter, i, a);
        hold(deviceOf(a.fromSpot), i, a);
        if (deviceOf(a.toSpot) !== deviceOf(a.fromSpot)) hold(deviceOf(a.toSpot), i, a);
        break;
      case "relay":
        push(byArc, arcKey(a.arc), i);
        break;
      case "replenishment":
        hold(a.device, i, a);
        hold(a.replenisher, i, a);
        break;
    }
  });

  // Legs in travel order, so an Object trace reads front to back.
  for (const list of byArc.values())
    list.sort((x, y) => {
      const ax = activities[x]!;
      const ay = activities[y]!;
      const sx = "seq" in ax ? (ax.seq ?? 0) : 0;
      const sy = "seq" in ay ? (ay.seq ?? 0) : 0;
      return sx - sy || ax.start - ay.start || x - y;
    });

  const machines = collectMachines(env, spans, horizon);
  const resources = replayResources(doc, env);

  const counts: Record<Activity["kind"], number> = {
    processing: 0,
    transport: 0,
    relay: 0,
    replenishment: 0,
    decision: 0,
    gate: 0,
    reservation: 0,
  };
  for (const a of activities) counts[a.kind] += 1;

  return {
    doc,
    env,
    workflow,
    unit: doc.time?.unit ?? env?.time?.unit ?? "",
    activities,
    byNode,
    byArc,
    byMachine,
    assumed: assumedWork(activities),
    machines,
    resources,
    metrics: {
      makespan,
      horizon,
      counts,
      busiest: machines.filter((m) => m.occupancy > 0).slice(0, 10),
    },
  };
}

/**
 * Machines in a stable order: the environment's, when there is one, so two
 * plans of the same lab line up lane for lane. Otherwise whatever the document
 * mentions, which is all a bare plan gives us.
 */
function collectMachines(
  env: Environment | undefined,
  spans: ReadonlyMap<string, [number, number][]>,
  horizon: number,
): Machine[] {
  const out: Machine[] = [];
  const seen = new Set<string>();
  const add = (id: string, kind: MachineKind): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const held = spans.get(id);
    out.push({
      id,
      kind,
      occupancy: held && horizon > 0 ? mergedLength(held) / horizon : 0,
    });
  };

  for (const d of env?.devices ?? []) add(d.id, "device");
  for (const t of env?.transporters ?? []) add(t.id, "transporter");
  for (const r of env?.replenishers ?? []) add(r.id, "replenisher");
  for (const id of spans.keys()) add(id, "device");

  return out;
}

/**
 * Replay every stock from its starting level through the run.
 *
 * A refill is credited when it finishes — stock that is still being poured is
 * not yet usable — and a step's consumption is debited when it starts.
 */
function replayResources(doc: ExecutionDocument, env: Environment | undefined): ResourceTrace[] {
  const start = new Map<string, number>();
  for (const [device, byResource] of Object.entries(doc.inventories?.levels ?? {}))
    for (const [resource, level] of Object.entries(byResource)) start.set(`${device}.${resource}`, level);

  // A resource the environment declares but the document does not name starts
  // at zero (§6.10), and is worth showing: an empty stock is a fact.
  for (const device of env?.devices ?? [])
    for (const resource of Object.keys(device.resources ?? {}))
      if (!start.has(`${device.id}.${resource}`)) start.set(`${device.id}.${resource}`, 0);

  const events = new Map<string, { at: number; delta: number }[]>();
  const add = (ref: string, at: number, delta: number): void => {
    if (!start.has(ref)) start.set(ref, 0);
    const list = events.get(ref);
    if (list) list.push({ at, delta });
    else events.set(ref, [{ at, delta }]);
  };
  for (const a of doc.activities) {
    if (a.kind === "processing")
      for (const [ref, amount] of Object.entries(a.consumption ?? {})) add(ref, a.start, -amount);
    else if (a.kind === "replenishment")
      for (const [resource, amount] of Object.entries(a.amounts)) add(`${a.device}.${resource}`, a.end, amount);
  }
  if (start.size === 0) return [];

  const capacity = new Map<string, number>();
  for (const device of env?.devices ?? [])
    for (const [resource, def] of Object.entries(device.resources ?? {}))
      capacity.set(`${device.id}.${resource}`, def.capacity);

  const out: ResourceTrace[] = [];
  for (const [ref, initial] of start) {
    const timeline = [...(events.get(ref) ?? [])].sort((x, y) => x.at - y.at);
    let level = initial;
    let low = timeline.length ? Number.POSITIVE_INFINITY : initial;
    let refills = 0;
    let consumed = 0;
    for (const e of timeline) {
      level += e.delta;
      if (e.delta > 0) refills += 1;
      else consumed -= e.delta;
      low = Math.min(low, level);
    }
    out.push({ ref, capacity: capacity.get(ref), start: initial, low, end: level, refills, consumed });
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref));
}

/**
 * The activities under a region whose outcome is assumed (`Scene.assumed`).
 * Under means the region's own path is a prefix of the activity's — of a
 * step's node, or of either end of a move's arc.
 */
function assumedWork(activities: readonly Activity[]): Set<number> {
  const regions = activities
    .filter((a) => a.kind === "decision" && a.assumed && a.arm !== "exit" && a.arm !== "continue")
    .map((a) => pathKey((a as { node: NodePath }).node));
  const out = new Set<number>();
  if (!regions.length) return out;
  const under = (p: NodePath): boolean => {
    const k = pathKey(p);
    return regions.some((r) => k === r || k.startsWith(`${r}.`));
  };
  activities.forEach((a, i) => {
    if (a.kind === "processing" ? under(a.node) : (a.kind === "transport" || a.kind === "relay") && (under(a.arc.from.node) || under(a.arc.to.node)))
      out.add(i);
  });
  return out;
}

/** Total time covered by a set of possibly overlapping intervals. */
function mergedLength(intervals: readonly [number, number][]): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur = sorted[0];
  if (!cur) return 0;
  let [cs, ce] = cur;
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i]!;
    if (s > ce) {
      total += ce - cs;
      cs = s;
      ce = e;
    } else if (e > ce) ce = e;
  }
  return total + (ce - cs);
}

/** §6.1: `objective.value` is a scalar or a list; the makespan is the first. */
function scalarObjective(doc: ExecutionDocument): number | undefined {
  const v = doc.objective?.value;
  if (typeof v === "number") return v;
  if (Array.isArray(v) && typeof v[0] === "number") return v[0];
  return undefined;
}

/**
 * The devices a processing activity holds.
 *
 * §6.3 makes `devices` a *derivable echo* that a document may leave out — a
 * status carried into a replan often does. Reading it as the truth makes such
 * an activity vanish from any device-keyed view, so recover it: from the
 * environment's mode when there is one (authoritative, and it may hold a
 * device that owns no spot), otherwise from the qualified spots the activity
 * does carry. A Pure-Data-only step legitimately holds nothing and returns [].
 */
export function holdingDevices(a: ProcessingActivity, env?: Environment): string[] {
  if (a.devices?.length) return [...a.devices];

  const mode = env?.processes[a.process]?.modes.find((m) => m.id === a.mode);
  if (mode?.devices.length) return [...mode.devices];

  const spots = [...Object.values(a.inputSpots ?? {}), ...Object.values(a.outputSpots ?? {})];
  return [...new Set(spots.map(deviceOf))];
}

/**
 * Whether a step accesses the devices it names, or merely rests material on
 * their spots (§4.4.2). The echo is written only where it is false (§6.3), so
 * its absence falls back to the environment's mode, and then to the default.
 */
export function accessesDevices(a: ProcessingActivity, env?: Environment): boolean {
  if (a.deviceAccess === false) return false;
  const mode = env?.processes[a.process]?.modes.find((m) => m.id === a.mode);
  return mode?.deviceAccess !== false;
}

/**
 * Every activity at or below a workflow node — a collapsed composite stands
 * for all of its descendants, which is what D11's badge counts.
 *
 * `path` is the node's path in the workflow's own structure, with no
 * invocation positions (`sourcePath`): every invocation of a structured node
 * is that node. What a decision, gate or reservation names is under it too.
 */
export function activitiesUnder(scene: Scene, path: NodePath): number[] {
  const prefix = pathKey(sourcePath(path));
  const isUnder = (p: NodePath): boolean => {
    const k = pathKey(sourcePath(p));
    return prefix === "" || k === prefix || k.startsWith(prefix + ".");
  };
  const out: number[] = [];
  scene.activities.forEach((a, i) => {
    if (a.kind === "replenishment") return;
    if (a.kind === "transport" || a.kind === "relay") {
      // Moves belong to a node when either end of their arc sits under it.
      if ([a.arc.from, a.arc.to].some((end) => end.node.length > 0 && isUnder(end.node))) out.push(i);
      return;
    }
    if (isUnder(a.node)) out.push(i);
  });
  return out;
}

/** The activities that move the same Object as this one — its whole journey. */
export function sameArc(scene: Scene, index: number): number[] {
  const a = scene.activities[index];
  if (!a || (a.kind !== "transport" && a.kind !== "relay")) return [index];
  return [...(scene.byArc.get(arcKey(a.arc)) ?? [index])];
}
