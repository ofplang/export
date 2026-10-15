/**
 * Gantt lanes and bars.
 *
 * Four ways to slice the same plan, the first three ported from `ofp-schedule`'s
 * `visualize.py` (design.md D12 — the algorithm, not the code):
 *
 * - `device`   one lane per machine. A move draws a solid bar on its
 *              transporter and held bars on the devices at either end,
 *              because a transport occupies all three (§4.5). Best for
 *              reading contention.
 * - `flow`     one lane per top-level node of the entry composite, so
 *              parallel branches sit side by side. Best for reading
 *              concurrency at a glance.
 * - `activity` one lane per activity, in start order. Best for reading a
 *              plan step by step.
 * - `object`   one lane per Object, from where it appears to where it ends
 *              (design.md §23). Best for reading what happens to one plate.
 *              Only where the Objects can be told apart (`traceObjects`).
 *
 * In a plan of several jobs (§6.11) the jobs are not told apart by colour —
 * planned together, they are one plan. `job` narrows any view to one of them
 * (and the refills, which serve them all); the flow view gives each job its
 * own lanes.
 *
 * Pure functions over the scene: no DOM, no colours, no pixels.
 */

import { deviceOf, pathText, sourcePath, spotNameOf } from "../model/common";
import type { Activity } from "../model/document";
import { tracingOf, type SegmentKind } from "../model/objects";
import { accessesDevices, holdingDevices, type Scene } from "../model/scene";

export type GanttView = "device" | "flow" | "activity" | "object";

export const GANTT_VIEWS: readonly { id: GanttView; label: string; hint: string }[] = [
  { id: "device", label: "Device", hint: "one lane per machine — shows contention" },
  { id: "flow", label: "Flow", hint: "one lane per top-level step — shows concurrency" },
  { id: "activity", label: "Activity", hint: "one lane per activity — shows the sequence" },
  { id: "object", label: "Object", hint: "one lane per Object — follows each from where it appears to where it ends" },
];

/**
 * `resting` is a step that holds its spots but not its device (§4.4.2);
 * `waiting` an Object sitting on a spot between two things that happen to it.
 */
export type BarStyle =
  | "processing"
  | "resting"
  | "transport"
  | "held"
  | "relay"
  | "replenishment"
  | "waiting"
  | "decision"
  | "gate"
  | "reserved";

export interface Lane {
  readonly id: string;
  readonly label: string;
  /** A short right-aligned tag in the gutter; empty when it says nothing. */
  readonly tag: string;
  /**
   * Where a label too long for the gutter loses characters. `middle` keeps
   * the end, for labels that differ only there — `Preparation.prep_out_a3_24`
   * beside `Preparation.prep_out_rf12`.
   */
  readonly elide?: "middle";
  /** The Object this lane follows, in the Object view — its label selects it. */
  readonly object?: string;
}

export interface Bar {
  readonly lane: number;
  /**
   * Index into `scene.activities` — the identity used by the selection.
   * Absent only on a wait in the Object view, which is no activity.
   */
  readonly index?: number;
  /** The Object whose lane this is, in the Object view. */
  readonly object?: string;
  readonly start: number;
  readonly end: number;
  readonly style: BarStyle;
  readonly label: string;
}

export interface GanttLayout {
  readonly lanes: readonly Lane[];
  readonly bars: readonly Bar[];
}

export function ganttLayout(scene: Scene, view: GanttView, job?: string): GanttLayout {
  const shown = (a: Activity): boolean => job === undefined || a.job === job || a.kind === "replenishment";
  switch (view) {
    case "device":
      return deviceLayout(scene, shown);
    case "flow":
      return flowLayout(scene, shown, job === undefined && scene.jobs.length > 0);
    case "activity":
      return activityLayout(scene, shown);
    case "object":
      return objectLayout(scene, job);
  }
}

type Shown = (a: Activity) => boolean;

/** What to call an activity in one short phrase. */
export function activityLabel(a: Activity): string {
  const label = kindLabel(a);
  return a.job === undefined ? label : `${a.job} · ${label}`;
}

function kindLabel(a: Activity): string {
  switch (a.kind) {
    case "processing":
      return a.node.length ? a.node.join("/") : a.process;
    case "transport":
      return `${a.fromSpot} → ${a.toSpot}`;
    case "relay":
      return `wait at ${a.spot}`;
    case "replenishment":
      return `refill ${a.device}`;
    case "decision":
      return `decide ${pathText(a.node)}`;
    case "gate":
      return `gate ${pathText(a.node)}`;
    case "reservation":
      return `keep for ${pathText(a.node)}`;
  }
}

/**
 * What a decision says, in a few words: the arm, the loop ending, the length,
 * with a `?` while the plan only assumes it (§6.14).
 */
export function decisionText(a: Activity & { kind: "decision" }): string {
  const what =
    a.length !== undefined
      ? `${a.length} long`
      : a.arm === "exit"
        ? `ends after ${(a.iteration ?? 0) + 1}`
        : a.arm === "continue"
          ? "goes on"
          : (a.arm ?? "");
  return a.assumed ? `${what}?` : what;
}

/** The short form used inside a bar, where there is little room. */
function barLabel(a: Activity): string {
  switch (a.kind) {
    case "processing":
      return a.node.length ? String(a.node[a.node.length - 1]) : a.process;
    case "transport":
      return `${deviceOf(a.fromSpot)} → ${deviceOf(a.toSpot)}`;
    case "relay":
    case "gate":
      return "";
    case "replenishment":
      return `+${Object.keys(a.amounts).join(", ")}`;
    case "decision":
      return `${sourcePath(a.node).at(-1) ?? ""} ${decisionText(a)}`;
    case "reservation":
      return sourcePath(a.node).at(-1) ?? "";
  }
}

/** Lane for work that holds no machine at all — a Pure-Data-only step (§5.5).
 *  It exists only when something needs it; nothing disappears silently. */
const NO_MACHINE = "(no device)";

/** Lane for the decisions, which happen on no machine (§6.14). Only when there are some. */
const DECISIONS = "(decisions)";

function deviceLayout(scene: Scene, shown: Shown): GanttLayout {
  // Bars are filed by lane id first and numbered at the end, because spot
  // lanes are only known once the activities have been read.
  const filed: (Omit<Bar, "lane"> & { laneId: string })[] = [];
  /** device id → the spot lanes that sit under it, in order of first use. */
  const spotLanes = new Map<string, string[]>();
  const spotLane = (spot: string): string => {
    const device = deviceOf(spot);
    const list = spotLanes.get(device) ?? [];
    if (!list.includes(spot)) list.push(spot);
    spotLanes.set(device, list);
    return spot;
  };

  scene.activities.forEach((a, index) => {
    if (!shown(a)) return;
    const at = (id: string | undefined, style: BarStyle, label: string): void => {
      if (id) filed.push({ laneId: id, index, start: a.start, end: a.end, style, label });
    };

    switch (a.kind) {
      case "processing": {
        const style = styleOf(a, scene);
        if (style === "resting") {
          // A resting step holds spots, not a device (§4.4.2), and two of them
          // may share one device at the same time — a fridge with two slots.
          // On the device's own lane they would overlap, so each goes on the
          // lane of the spot it holds, directly under its device.
          for (const spot of heldSpots(a, scene)) at(spotLane(spot), style, barLabel(a));
          break;
        }
        const held = holdingDevices(a, scene.env);
        if (held.length) for (const d of held) at(d, style, barLabel(a));
        else at(NO_MACHINE, style, barLabel(a));
        break;
      }
      case "transport": {
        const from = deviceOf(a.fromSpot);
        const to = deviceOf(a.toSpot);
        if (a.transporter) {
          at(a.transporter, "transport", barLabel(a));
          // Held, not moving: the endpoints are blocked for the duration (§4.5).
          at(from, "held", "");
          if (to !== from) at(to, "held", "");
        } else if (a.fromSpot === a.toSpot) {
          // A same-spot move is a no-op no transporter performs (§6.4).
          at(from, "transport", "");
        } else {
          // A route that needs no transporter is performed by the devices
          // themselves — both are occupied, nothing else is (§4.6).
          at(from, "transport", barLabel(a));
          if (to !== from) at(to, "transport", "");
        }
        break;
      }
      case "relay":
        at(deviceOf(a.spot), "relay", "");
        break;
      case "replenishment":
        at(a.device, "replenishment", barLabel(a));
        at(a.replenisher, "replenishment", "");
        break;
      case "decision":
        at(DECISIONS, "decision", barLabel(a));
        break;
      case "gate":
        // An Object waits in its gate on a spot; a Pure Data gate is on none,
        // so it goes where the work that holds no machine does.
        at(a.spot ? deviceOf(a.spot) : NO_MACHINE, "gate", "");
        break;
      case "reservation":
        // Kept spots, not a device: on each spot's own lane (§6.16).
        for (const spot of a.spots) at(spotLane(spot), "reserved", barLabel(a));
        break;
    }
  });

  // Machines in the scene's order, each followed by its spot lanes. A machine
  // nothing touches is dropped — an environment often declares more than a
  // given plan uses, and empty lanes are just noise — but one whose spots are
  // used keeps its row, so the spot lanes stay under the name they belong to.
  const used = new Set(filed.map((b) => b.laneId));
  const lanes: Lane[] = [];
  const machineIds = [...scene.machines.map((m) => m.id)];
  for (const device of spotLanes.keys()) if (!machineIds.includes(device)) machineIds.push(device);
  for (const id of machineIds) {
    const spots = spotLanes.get(id) ?? [];
    if (!used.has(id) && !spots.length) continue;
    const kind = scene.machines.find((m) => m.id === id)?.kind ?? "device";
    lanes.push({ id, label: id, tag: kind === "device" ? "" : kind });
    for (const spot of spots) lanes.push({ id: spot, label: `· ${spotNameOf(spot)}`, tag: "spot" });
  }
  if (used.has(NO_MACHINE)) lanes.push({ id: NO_MACHINE, label: NO_MACHINE, tag: "" });
  if (used.has(DECISIONS)) lanes.push({ id: DECISIONS, label: "decisions", tag: "" });

  const laneOf = new Map(lanes.map((l, i) => [l.id, i]));
  const bars: Bar[] = [];
  for (const { laneId, ...bar } of filed) {
    const lane = laneOf.get(laneId);
    if (lane !== undefined) bars.push({ ...bar, lane });
  }
  return { lanes, bars };
}

/** The spots a processing step binds: its echo, or else its mode's (§6.3). */
function heldSpots(a: Activity & { kind: "processing" }, scene: Scene): string[] {
  const echo = [...Object.values(a.inputSpots ?? {}), ...Object.values(a.outputSpots ?? {})];
  if (echo.length) return [...new Set(echo)];
  const mode = scene.env?.processes[a.process]?.modes.find((m) => m.id === a.mode);
  return [...new Set([...Object.values(mode?.inputSpots ?? {}), ...Object.values(mode?.outputSpots ?? {})])];
}

/** The top-level node an activity belongs to; moves are filed under their source. */
function groupOf(a: Activity): string {
  if (a.kind === "replenishment") return "refills";
  if (a.kind === "transport" || a.kind === "relay") {
    const from = a.arc.from.node[0];
    const to = a.arc.to.node[0];
    return String(from ?? to ?? "interface");
  }
  return a.node[0] === undefined ? "—" : String(a.node[0]);
}

function flowLayout(scene: Scene, shown: Shown, byJob: boolean): GanttLayout {
  // Each job its own lanes, in roster order, when every job is on screen.
  const group = (a: Activity): string => (byJob && a.job !== undefined ? `${a.job} · ${groupOf(a)}` : groupOf(a));
  const jobRank = (a: Activity): number => (byJob && a.job !== undefined ? scene.jobs.indexOf(a.job) : scene.jobs.length);
  const order: { id: string; rank: number }[] = [];
  for (const a of scene.activities) {
    if (!shown(a)) continue;
    const g = group(a);
    if (!order.some((o) => o.id === g)) order.push({ id: g, rank: jobRank(a) });
  }
  order.sort((x, y) => x.rank - y.rank);
  const laneOf = new Map(order.map((g, i) => [g.id, i]));
  return {
    lanes: order.map((g) => ({ id: g.id, label: g.id, tag: "" })),
    bars: scene.activities.flatMap((a, index) =>
      shown(a)
        ? [{ lane: laneOf.get(group(a))!, index, start: a.start, end: a.end, style: styleOf(a, scene), label: barLabel(a) }]
        : [],
    ),
  };
}

function activityLayout(scene: Scene, shown: Shown): GanttLayout {
  const order = scene.activities
    .map((a, index) => ({ a, index }))
    .filter(({ a }) => shown(a))
    .sort((x, y) => x.a.start - y.a.start || x.index - y.index);

  return {
    lanes: order.map(({ a }) => ({ id: activityLabel(a), label: activityLabel(a), tag: KIND_TAG[a.kind] })),
    bars: order.map(({ a, index }, lane) => ({
      lane,
      index,
      start: a.start,
      end: a.end,
      style: styleOf(a, scene),
      label: "",
    })),
  };
}

/**
 * One lane per Object: its origin as the label, its type as the tag
 * (design.md D58). Nothing at all where the Objects cannot be told apart —
 * the view is not offered then (D59), and a lane pieced together would look
 * exactly like a true one.
 */
function objectLayout(scene: Scene, job: string | undefined): GanttLayout {
  const tracing = tracingOf(scene);
  if (!tracing.ok) return { lanes: [], bars: [] };

  const bars: Bar[] = [];
  const traces = tracing.traces.filter((t) => job === undefined || t.job === job);
  const lanes = traces.map((t, lane) => {
    for (const s of t.segments) {
      const a = s.activity === undefined ? undefined : scene.activities[s.activity];
      bars.push({
        lane,
        ...(s.activity === undefined ? {} : { index: s.activity }),
        object: t.id,
        start: s.start,
        end: s.end,
        style: SEGMENT_STYLE[s.kind],
        label: a ? barLabel(a) : "",
      });
    }
    return { id: t.id, label: t.where, tag: t.type, elide: "middle" as const, object: t.id };
  });
  return { lanes, bars };
}

const SEGMENT_STYLE: Readonly<Record<SegmentKind, BarStyle>> = {
  processing: "processing",
  resting: "resting",
  waiting: "waiting",
  transport: "transport",
  relay: "relay",
  gate: "gate",
};

/** Short enough for the gutter, still a word. */
const KIND_TAG: Readonly<Record<Activity["kind"], string>> = {
  processing: "step",
  transport: "move",
  relay: "wait",
  replenishment: "refill",
  decision: "decide",
  gate: "gate",
  reservation: "keep",
};

function styleOf(a: Activity, scene: Scene): BarStyle {
  switch (a.kind) {
    case "processing":
      return accessesDevices(a, scene.env) ? "processing" : "resting";
    case "transport":
      return "transport";
    case "relay":
      return "relay";
    case "replenishment":
      return "replenishment";
    case "decision":
      return "decision";
    case "gate":
      return "gate";
    case "reservation":
      return "reserved";
  }
}
