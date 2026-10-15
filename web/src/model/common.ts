/**
 * Identifiers and references shared by the environment definition, the
 * execution document and the workflow.
 *
 * Spec references are to `external/ofplang-schedule/docs/SPECIFICATIONS.md`
 * unless marked "workflow spec", which means `ofplang-spec/SPECIFICATION.md`.
 */

/** A qualified spot, `<device>.<spot>`. Neither part contains a `.` (§8). */
export type SpotRef = string;

export type DeviceId = string;
export type TransporterId = string;

/** A qualified resource, `<device>.<resource>` (§8.2). */
export type ResourceRef = string;

/**
 * One step of a node path: a node id, or the position of one invocation of a
 * `map` / `fold` / `do_while` (§6.3) — `[Wash, 2, aspirate]` is `aspirate` in
 * invocation 2 of `Wash`. A gate adds the reserved `"@out"` and its port, and
 * for one element of an Array that element's index (§6.3, §6.15).
 */
export type PathStep = string | number;

/**
 * A node path: node ids from the entry composite's body down to the atomic
 * node invoked (§6.3), with an invocation's position after the id of the node
 * it belongs to.
 *
 * The empty path denotes the entry composite itself — the workflow interface.
 * A boundary transport's arc uses it on the side that touches the interface
 * (§6.4), and it cannot collide with an atomic node, which always has a
 * non-empty path.
 */
export type NodePath = readonly PathStep[];

/** The reserved step that names a gate (§6.3, §6.15). */
export const GATE_OUT = "@out";

/**
 * Index key for a node path. `.` never occurs inside an identifier (§8.1),
 * and an identifier never starts with a digit, so an invocation's position
 * (`Each.0.Look`) cannot be mistaken for a node id.
 */
export const pathKey = (p: NodePath): string => p.join(".");

/** A node path as the specification writes it in text (§6.3): `Wash/2/aspirate`. */
export const pathText = (p: NodePath): string => p.join("/");

/**
 * The workflow node a plan path stands for: each invocation's position
 * dropped, and a gate's path cut back to the region it belongs to. Every
 * invocation of a node is that one node in the workflow's own structure,
 * which is what the graph draws (design.md D11).
 */
export function sourcePath(p: NodePath): string[] {
  const out: string[] = [];
  for (const step of p) {
    if (step === GATE_OUT) break;
    if (typeof step === "string") out.push(step);
  }
  return out;
}

/** Whether a path names a gate (§6.15) rather than a node. */
export const isGatePath = (p: NodePath): boolean => p.includes(GATE_OUT);

/** The device half of a qualified spot. */
export const deviceOf = (spot: SpotRef): DeviceId => {
  const i = spot.indexOf(".");
  return i < 0 ? spot : spot.slice(0, i);
};

/** The spot half of a qualified spot. */
export const spotNameOf = (spot: SpotRef): string => {
  const i = spot.indexOf(".");
  return i < 0 ? "" : spot.slice(i + 1);
};

/** One end of an Object-bearing arc (§6.4). */
export interface PortRef {
  readonly node: NodePath;
  readonly port: string;
  /** One element of an Array the port carries, by its position (§6.4). */
  readonly index?: readonly number[];
}

/** The logical connection a transport serves (§6.4). */
export interface ArcRef {
  readonly from: PortRef;
  readonly to: PortRef;
}

/** True when this end of an arc is the workflow interface rather than a node. */
export const isBoundary = (e: PortRef): boolean => e.node.length === 0;

/** A port end as text, its element index included when it has one. */
export const portRefKey = (e: PortRef): string =>
  `${pathKey(e.node)}|${e.port}${e.index ? `[${e.index.join(",")}]` : ""}`;

/**
 * A key within one job (§6.11). Two jobs of one workflow write the same paths
 * and the same arcs, so in a plan of several every index key carries its job;
 * in a plan of one there is none, and the key is as it always was. `:` occurs
 * in no identifier (§8.1).
 */
export const jobScoped = (job: string | undefined, key: string): string => (job === undefined ? key : `${job}:${key}`);

/** Stable key for an arc, so every leg of a multi-hop move shares one key. */
export const arcKey = (a: ArcRef): string => `${portRefKey(a.from)}>${portRefKey(a.to)}`;
