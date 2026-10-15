/**
 * The execution document — SPECIFICATIONS.md §6.
 *
 * A plan and a status share one schema; only the presence of `status` on the
 * activities separates them (§6.2). One reader serves both.
 */

import type { ArcRef, DeviceId, NodePath, PortRef, ResourceRef, SpotRef, TransporterId } from "./common";

export type Outcome = "optimal" | "feasible" | "infeasible" | "unknown";

/**
 * §6.2. `failed` and `cancelled` are terminal and appear only in a final
 * status; a document carrying one is not a replanning input.
 */
export type ActivityStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export const TERMINAL_STATUSES: readonly ActivityStatus[] = ["failed", "cancelled"];

/** §6.1 `objective`. Both fields take a scalar or a list, and agree in shape. */
export interface Objective {
  readonly kind: string | readonly string[];
  readonly value?: number | readonly number[];
}

/**
 * §6.8. Where a boundary port's Objects sit: a spot, or for an Array a list of
 * them in element order, nested as the Array is.
 */
export type SpotTree = SpotRef | readonly SpotTree[];

/** §6.8. Boundary Object-bearing material pinned to spots. */
export interface InterfaceBinding {
  readonly inputs: Readonly<Record<string, SpotTree>>;
  readonly outputs?: Readonly<Record<string, SpotTree>>;
}

/**
 * §6.13. What the run has said about the expansion: the length of a list, the
 * arm a branch takes, how many invocations a loop has had. As written; where
 * nothing is stated, a plan assumes (§6.14).
 */
export interface Expansion {
  readonly lengths: readonly {
    readonly node: NodePath;
    readonly port: string;
    readonly index?: readonly number[];
    readonly length: number;
  }[];
  readonly arms: readonly { readonly node: NodePath; readonly arm: "then" | "else" }[];
  readonly loops: readonly { readonly node: NodePath; readonly count: number; readonly ended: boolean }[];
}

/** §6.10. Consumable levels as of the start of the run. */
export interface Inventories {
  readonly levels: Readonly<Record<DeviceId, Readonly<Record<string, number>>>>;
}

interface ActivityBase {
  readonly status: ActivityStatus;
  readonly start: number;
  readonly end: number;
  /**
   * Reserved for a later "planned vs actual" overlay (design.md D3).
   * Nothing writes it yet; the reader never populates it.
   */
  readonly actual?: { readonly start: number; readonly end: number; readonly status: ActivityStatus };
}

/** §6.3. */
export interface ProcessingActivity extends ActivityBase {
  readonly kind: "processing";
  readonly process: string;
  readonly mode: string;
  /** Non-empty: an atomic node always has a path (§6.3). */
  readonly node: NodePath;
  readonly devices?: readonly DeviceId[];
  readonly inputSpots?: Readonly<Record<string, SpotRef>>;
  readonly outputSpots?: Readonly<Record<string, SpotRef>>;
  readonly consumption?: Readonly<Record<ResourceRef, number>>;
  /**
   * §6.3 echo of the mode's `device_access`, written only where it is false:
   * the material rests on its spots and the device is free meanwhile (§4.4.2).
   */
  readonly deviceAccess?: false;
}

/**
 * §6.4. `transporter` is absent on a move no transporter performs: a
 * same-spot move (a no-op, the key omitted) or a route that needs none (§4.6,
 * written as `null`). Both still occupy the devices at either end.
 */
export interface TransportActivity extends ActivityBase {
  readonly kind: "transport";
  readonly fromSpot: SpotRef;
  readonly toSpot: SpotRef;
  readonly transporter?: TransporterId;
  /** Every leg of a multi-leg move carries the same logical arc (§6.4). */
  readonly arc: ArcRef;
  readonly seq?: number;
}

/** §6.4.1. A junction between two legs; instantaneous, so `end === start`. */
export interface RelayActivity extends ActivityBase {
  readonly kind: "relay";
  readonly arc: ArcRef;
  readonly seq: number;
  readonly spot: SpotRef;
}

/** §6.9. Has no `node`: a refill does not come from the workflow (§4.2). */
export interface ReplenishmentActivity extends ActivityBase {
  readonly kind: "replenishment";
  readonly id: string;
  readonly device: DeviceId;
  readonly replenisher: string;
  /** Keyed by bare resource name; the device is already named. */
  readonly amounts: Readonly<Record<string, number>>;
}

/**
 * §6.14. The moment a run decides what the plan could only assume: the arm a
 * branch takes, whether a loop goes on, how long a list is. Instantaneous, at
 * the planned end of what the condition waits for; gone from the plan once
 * that has happened. `assumed` says whether the plan stands on a guess.
 */
export interface DecisionActivity extends ActivityBase {
  readonly kind: "decision";
  readonly node: NodePath;
  readonly assumed: boolean;
  /** Where the value the decision reads is made. */
  readonly condition: PortRef;
  /** A branch's arm (`then` / `else`); a loop's `exit` after `iteration`, or `continue`. */
  readonly arm?: "then" | "else" | "exit" | "continue";
  /** A loop: the invocation (from 0) the decision follows. */
  readonly iteration?: number;
  /** A traversal: its length, assumed or stated. */
  readonly length?: number;
}

/**
 * §6.15. Where a region's outcome leaves it: what follows starts from here
 * whichever way the region was decided. Instantaneous. `spot` is where an
 * Object waits in it; a Pure Data gate has none.
 */
export interface GateActivity extends ActivityBase {
  readonly kind: "gate";
  readonly node: NodePath;
  readonly spot?: SpotRef;
}

/**
 * §6.16. Spots kept for a region while its outcome is open, so the plan holds
 * whichever way it turns out. A window on spots, not on any device.
 */
export interface ReservationActivity extends ActivityBase {
  readonly kind: "reservation";
  readonly node: NodePath;
  readonly spots: readonly SpotRef[];
}

export type Activity =
  | ProcessingActivity
  | TransportActivity
  | RelayActivity
  | ReplenishmentActivity
  | DecisionActivity
  | GateActivity
  | ReservationActivity;

/** An activity that carries a logical arc — every leg and junction of a move. */
export type ArcActivity = TransportActivity | RelayActivity;

export const hasArc = (a: Activity): a is ArcActivity =>
  a.kind === "transport" || a.kind === "relay";

/** §6.1. */
export interface ExecutionDocument {
  readonly time?: { readonly unit: string };
  /** The reference time of a replan (§6.1). Absent on an initial plan. */
  readonly now?: number;
  readonly interface?: InterfaceBinding;
  readonly expansion?: Expansion;
  readonly inventories?: Inventories;
  readonly outcome?: Outcome;
  readonly objective?: Objective;
  readonly activities: readonly Activity[];
  /** §6.12. Spots a stopped job left held; the plan may not use them. */
  readonly occupied?: readonly { readonly spot: SpotRef; readonly since: number }[];
  readonly meta?: { readonly workflow?: string; readonly environment?: string };
}
