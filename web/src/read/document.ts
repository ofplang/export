/**
 * Read an execution document — SPECIFICATIONS.md §6.
 *
 * Plan and status share one schema (§6.2), so this one reader serves both.
 * Unknown keys are kept out of the model but never rejected: `x-` extension
 * keys are legal (§9.4) and a newer scheduler may add fields this viewer has
 * not learned yet.
 *
 * The spec's exceptions are the parts worth reading twice — they are what a
 * naive reader gets wrong:
 *   - `transporter` is absent on a same-spot move, and `null` on a route that
 *     needs none (§6.4). A real move with the key missing is malformed.
 *   - A joint plan (`jobs`, §6.11) is refused before anything is read (D42).
 *   - Every leg of a multi-hop move carries the *same* logical `arc`; the legs
 *     differ by `seq` and by their physical spots (§6.4).
 *   - A stay-put relay is folded out of the output; its absence is normal (§6.4.1).
 *   - A boundary arc endpoint has an *empty* node path — not a missing one (§6.4).
 *   - `objective.kind` / `value` are a scalar or a list (§6.1).
 *   - A Pure-Data-only processing activity has no devices and no spots (§6.3).
 *   - A path names each invocation of a structured node by its position — an
 *     integer, never a string — and a gate by `"@out"` and its port (§6.3).
 *   - A decision, a gate and a reservation (§6.14-§6.16) are planned, never
 *     dispatched; a decision and a gate are instants, and all three disappear
 *     from the plan once what they stand for has happened.
 *   - An Array at the boundary is bound to a list of spots, nested as it is (§6.8).
 */

import { parse as parseYaml } from "yaml";

import { GATE_OUT, type ArcRef, type NodePath, type PortRef } from "../model/common";
import type {
  Activity,
  ActivityStatus,
  DecisionActivity,
  ExecutionDocument,
  Expansion,
  GateActivity,
  InterfaceBinding,
  Inventories,
  Objective,
  Outcome,
  ProcessingActivity,
  RelayActivity,
  ReplenishmentActivity,
  ReservationActivity,
  SpotTree,
  TransportActivity,
} from "../model/document";
import {
  at,
  numberMap,
  oneOf,
  optBoolean,
  optList,
  optNumber,
  optRecord,
  optString,
  ReadError,
  reqIdLike,
  reqList,
  reqNumber,
  reqRecord,
  reqString,
  stringList,
  stringMap,
} from "./coerce";
import { gateDocument, UnsupportedError } from "./gate";

const OUTCOMES = ["optimal", "feasible", "infeasible", "unknown"] as const;
const STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;
const KINDS = ["processing", "transport", "relay", "replenishment", "decision", "gate", "reservation"] as const;
const DECISION_ARMS = ["then", "else", "exit", "continue"] as const;
const BRANCH_ARMS = ["then", "else"] as const;

/** Parse YAML text into an execution document. */
export function readExecutionDocumentText(text: string): ExecutionDocument {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ReadError("", `not valid YAML — ${(e as Error).message}`);
  }
  return readExecutionDocument(raw);
}

/** Read an already-parsed document (a plan or a status). */
export function readExecutionDocument(raw: unknown): ExecutionDocument {
  const doc = reqRecord(raw, "");
  const refused = gateDocument(doc);
  if (refused.length) throw new UnsupportedError(refused);

  const time = optRecord(doc["time"], "time");
  const iface = optRecord(doc["interface"], "interface");
  const inv = optRecord(doc["inventories"], "inventories");
  const obj = optRecord(doc["objective"], "objective");
  const meta = optRecord(doc["meta"], "meta");

  const activities = reqList(doc["activities"], "activities").map((a, i) =>
    readActivity(a, at("activities", i)),
  );

  const out: {
    -readonly [K in keyof ExecutionDocument]: ExecutionDocument[K];
  } = { activities };

  if (time) out.time = { unit: reqString(time["unit"], "time.unit") };
  const now = optNumber(doc["now"], "now");
  if (now !== undefined) out.now = now;
  if (iface) out.interface = readInterface(iface);
  const expansion = optRecord(doc["expansion"], "expansion");
  if (expansion) out.expansion = readExpansion(expansion);
  if (inv) out.inventories = readInventories(inv);
  if (doc["outcome"] !== undefined && doc["outcome"] !== null)
    out.outcome = oneOf<Outcome>(doc["outcome"], "outcome", OUTCOMES);
  if (obj) out.objective = readObjective(obj);
  const occupied = optList(doc["occupied"], "occupied");
  if (occupied)
    out.occupied = occupied.map((o, i) => {
      const e = reqRecord(o, at("occupied", i));
      return {
        spot: reqString(e["spot"], at(at("occupied", i), "spot")),
        since: reqNumber(e["since"], at(at("occupied", i), "since")),
      };
    });
  if (meta) {
    const wf = optString(meta["workflow"], "meta.workflow");
    const env = optString(meta["environment"], "meta.environment");
    const m: { workflow?: string; environment?: string } = {};
    if (wf !== undefined) m.workflow = wf;
    if (env !== undefined) m.environment = env;
    out.meta = m;
  }
  return out;
}

function readObjective(o: Record<string, unknown>): Objective {
  const rawKind = o["kind"];
  const kind = Array.isArray(rawKind)
    ? stringList(rawKind, "objective.kind")
    : reqString(rawKind, "objective.kind");

  const rawValue = o["value"];
  if (rawValue === undefined || rawValue === null) return { kind };
  const value = Array.isArray(rawValue)
    ? reqList(rawValue, "objective.value").map((v, i) => reqNumber(v, at("objective.value", i)))
    : reqNumber(rawValue, "objective.value");

  if (Array.isArray(kind) !== Array.isArray(value))
    throw new ReadError(
      "objective",
      "`kind` and `value` must have the same shape — both scalar or both lists (§6.1)",
    );
  return { kind, value };
}

function readInterface(i: Record<string, unknown>): InterfaceBinding {
  const side = (key: "inputs" | "outputs"): Record<string, SpotTree> | undefined => {
    const src = optRecord(i[key], at("interface", key));
    if (!src) return undefined;
    const out: Record<string, SpotTree> = {};
    for (const [port, spots] of Object.entries(src)) out[port] = readSpotTree(spots, at(at("interface", key), port));
    return out;
  };
  const inputs = side("inputs") ?? {};
  const outputs = side("outputs");
  return outputs ? { inputs, outputs } : { inputs };
}

function readInventories(i: Record<string, unknown>): Inventories {
  const src = reqRecord(i["levels"], "inventories.levels");
  const levels: Record<string, Record<string, number>> = {};
  for (const [dev, byRes] of Object.entries(src))
    levels[dev] = numberMap(byRes, at("inventories.levels", dev));
  return { levels };
}

function readActivity(raw: unknown, path: string): Activity {
  const a = reqRecord(raw, path);
  const kind = oneOf(a["kind"], at(path, "kind"), KINDS);

  const status: ActivityStatus =
    a["status"] === undefined || a["status"] === null
      ? "pending"
      : oneOf<ActivityStatus>(a["status"], at(path, "status"), STATUSES);
  const start = reqNumber(a["start"], at(path, "start"));
  const end = reqNumber(a["end"], at(path, "end"));
  if (end < start)
    throw new ReadError(path, `end (${end}) is before start (${start})`);

  const base = { status, start, end } as const;

  switch (kind) {
    case "processing":
      return readProcessing(a, path, base);
    case "transport":
      return readTransport(a, path, base);
    case "relay":
      return readRelay(a, path, base);
    case "replenishment":
      return readReplenishment(a, path, base);
    case "decision":
      return readDecision(a, path, base);
    case "gate":
      return readGate(a, path, base);
    case "reservation":
      return readReservation(a, path, base);
  }
}

function instantaneous(base: Base, path: string, what: string, section: string): void {
  if (base.end !== base.start)
    throw new ReadError(path, `a ${what} is instantaneous, but end (${base.end}) != start (${base.start}) (${section})`);
}

function readDecision(a: Record<string, unknown>, path: string, base: Base): DecisionActivity {
  instantaneous(base, path, "decision", "§6.14");
  const node = readNodePath(a["node"], at(path, "node"));
  if (node.length === 0) throw new ReadError(at(path, "node"), "a decision names its branch, loop or traversal (§6.14)");
  const assumed = optBoolean(a["assumed"], at(path, "assumed"));
  if (assumed === undefined) throw new ReadError(at(path, "assumed"), "a decision says whether it is assumed (§6.14)");
  const out: { -readonly [K in keyof DecisionActivity]: DecisionActivity[K] } = {
    ...base,
    kind: "decision",
    node,
    assumed,
    condition: readPortRef(a["condition"], at(path, "condition")),
  };
  if (a["arm"] !== undefined && a["arm"] !== null) out.arm = oneOf(a["arm"], at(path, "arm"), DECISION_ARMS);
  const iteration = optNumber(a["iteration"], at(path, "iteration"));
  if (iteration !== undefined) out.iteration = iteration;
  const length = optNumber(a["length"], at(path, "length"));
  if (length !== undefined) out.length = length;
  return out;
}

function readGate(a: Record<string, unknown>, path: string, base: Base): GateActivity {
  instantaneous(base, path, "gate", "§6.15");
  const node = readNodePath(a["node"], at(path, "node"));
  if (!node.includes(GATE_OUT))
    throw new ReadError(at(path, "node"), `a gate's path names it with "${GATE_OUT}" (§6.3)`);
  const spot = optString(a["spot"], at(path, "spot"));
  return spot === undefined ? { ...base, kind: "gate", node } : { ...base, kind: "gate", node, spot };
}

function readReservation(a: Record<string, unknown>, path: string, base: Base): ReservationActivity {
  const node = readNodePath(a["node"], at(path, "node"));
  if (node.length === 0) throw new ReadError(at(path, "node"), "a reservation names its region (§6.16)");
  const spots = stringList(a["spots"], at(path, "spots"));
  if (!spots.length) throw new ReadError(at(path, "spots"), "a reservation keeps at least one spot (§6.16)");
  return { ...base, kind: "reservation", node, spots };
}

function readExpansion(e: Record<string, unknown>): Expansion {
  const list = (key: string): Record<string, unknown>[] =>
    (optList(e[key], at("expansion", key)) ?? []).map((x, i) => reqRecord(x, at(at("expansion", key), i)));
  const lengths = list("lengths").map((x, i) => {
    const p = at(at("expansion", "lengths"), i);
    const index = readIndex(x["index"], at(p, "index"));
    return {
      node: readNodePath(x["node"], at(p, "node")),
      port: reqString(x["port"], at(p, "port")),
      ...(index ? { index } : {}),
      length: reqNumber(x["length"], at(p, "length")),
    };
  });
  const arms = list("arms").map((x, i) => {
    const p = at(at("expansion", "arms"), i);
    return { node: readNodePath(x["node"], at(p, "node")), arm: oneOf(x["arm"], at(p, "arm"), BRANCH_ARMS) };
  });
  const loops = list("loops").map((x, i) => {
    const p = at(at("expansion", "loops"), i);
    const ended = optBoolean(x["ended"], at(p, "ended"));
    if (ended === undefined) throw new ReadError(at(p, "ended"), "a loop's entry says whether it has ended (§6.13)");
    return { node: readNodePath(x["node"], at(p, "node")), count: reqNumber(x["count"], at(p, "count")), ended };
  });
  return { lengths, arms, loops };
}

/** A list of spots nested as the Array it binds is (§6.8), or one spot. */
function readSpotTree(raw: unknown, path: string): SpotTree {
  if (Array.isArray(raw)) return raw.map((x, i) => readSpotTree(x, at(path, i)));
  return reqString(raw, path);
}

type Base = { readonly status: ActivityStatus; readonly start: number; readonly end: number };

function readProcessing(
  a: Record<string, unknown>,
  path: string,
  base: Base,
): ProcessingActivity {
  const node = readNodePath(a["node"], at(path, "node"));
  if (node.length === 0)
    throw new ReadError(at(path, "node"), "a processing activity always has a non-empty node path (§6.3)");

  const out: { -readonly [K in keyof ProcessingActivity]: ProcessingActivity[K] } = {
    ...base,
    kind: "processing",
    process: reqString(a["process"], at(path, "process")),
    mode: reqIdLike(a["mode"], at(path, "mode")),
    node,
  };
  // All four are a derivable echo (§6.3) and are absent on a Pure-Data-only step.
  const devices = optList(a["devices"], at(path, "devices"));
  if (devices) out.devices = devices.map((d, i) => reqString(d, at(at(path, "devices"), i)));
  const inS = optRecord(a["input_spots"], at(path, "input_spots"));
  if (inS) out.inputSpots = stringMap(inS, at(path, "input_spots"));
  const outS = optRecord(a["output_spots"], at(path, "output_spots"));
  if (outS) out.outputSpots = stringMap(outS, at(path, "output_spots"));
  const cons = optRecord(a["consumption"], at(path, "consumption"));
  if (cons) out.consumption = numberMap(cons, at(path, "consumption"));
  if (optBoolean(a["device_access"], at(path, "device_access")) === false) out.deviceAccess = false;
  return out;
}

function readTransport(
  a: Record<string, unknown>,
  path: string,
  base: Base,
): TransportActivity {
  const fromSpot = reqString(a["from_spot"], at(path, "from_spot"));
  const toSpot = reqString(a["to_spot"], at(path, "to_spot"));
  const transporter = optString(a["transporter"], at(path, "transporter"));

  // §6.4: the key is required except on a same-spot move, which no transporter
  // performs. A real move that needs none says so with `null`; one missing the
  // key is a malformed document, not the same statement.
  if (!("transporter" in a) && fromSpot !== toSpot)
    throw new ReadError(
      path,
      `a transport between different spots names its transporter, or null for none (${fromSpot} -> ${toSpot}, §6.4)`,
    );

  const out: { -readonly [K in keyof TransportActivity]: TransportActivity[K] } = {
    ...base,
    kind: "transport",
    fromSpot,
    toSpot,
    arc: readArc(a["arc"], at(path, "arc")),
  };
  if (transporter !== undefined) out.transporter = transporter;
  const seq = optNumber(a["seq"], at(path, "seq"));
  if (seq !== undefined) out.seq = seq;
  return out;
}

function readRelay(a: Record<string, unknown>, path: string, base: Base): RelayActivity {
  instantaneous(base, path, "relay", "§6.4.1");
  return {
    ...base,
    kind: "relay",
    arc: readArc(a["arc"], at(path, "arc")),
    seq: reqNumber(a["seq"], at(path, "seq")),
    spot: reqString(a["spot"], at(path, "spot")),
  };
}

function readReplenishment(
  a: Record<string, unknown>,
  path: string,
  base: Base,
): ReplenishmentActivity {
  const amounts = numberMap(reqRecord(a["amounts"], at(path, "amounts")), at(path, "amounts"));
  if (Object.keys(amounts).length === 0)
    throw new ReadError(at(path, "amounts"), "a replenishment must add something (§6.9)");
  return {
    ...base,
    kind: "replenishment",
    id: reqString(a["id"], at(path, "id")),
    device: reqString(a["device"], at(path, "device")),
    replenisher: reqString(a["replenisher"], at(path, "replenisher")),
    amounts,
  };
}

/**
 * A node path (§6.3): node ids, each invocation's position after the id of
 * the node it belongs to, and for a gate `"@out"`, its port and any element
 * index. The empty list is the workflow interface.
 *
 * Positions are what a viewer most easily gets wrong, so the shape is held to
 * the rule: a position never starts a path, two never stand side by side
 * (before a gate's port), and nothing but a port and positions follows
 * `"@out"`.
 */
function readNodePath(raw: unknown, path: string): NodePath {
  if (raw === undefined || raw === null) return [];
  const steps = reqList(raw, path);
  const gate = steps.indexOf(GATE_OUT);
  steps.forEach((s, i) => {
    const where = at(path, i);
    if (typeof s === "number") {
      if (!Number.isInteger(s) || s < 0) throw new ReadError(where, `an invocation's position is a non-negative integer, got ${s}`);
      if (i === 0) throw new ReadError(where, "a path starts with a node id, not a position (§6.3)");
      const afterPort = gate >= 0 && i > gate + 1;
      if (!afterPort && typeof steps[i - 1] === "number")
        throw new ReadError(where, "two positions never stand side by side in a path (§6.3)");
      return;
    }
    if (typeof s !== "string") throw new ReadError(where, `expected a node id or a position, got ${JSON.stringify(s)}`);
    if (s === GATE_OUT) {
      if (i === 0 || i !== gate) throw new ReadError(where, `"${GATE_OUT}" follows a region's path, once (§6.3)`);
      return;
    }
    if (gate >= 0 && i > gate + 1) throw new ReadError(where, `only a port and element positions follow "${GATE_OUT}" (§6.3)`);
  });
  if (gate >= 0 && typeof steps[gate + 1] !== "string")
    throw new ReadError(path, `a gate's path names its port after "${GATE_OUT}" (§6.3)`);
  return steps as NodePath;
}

function readIndex(raw: unknown, path: string): number[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  return reqList(raw, path).map((x, i) => {
    const n = reqNumber(x, at(path, i));
    if (!Number.isInteger(n) || n < 0) throw new ReadError(at(path, i), `an element's position is a non-negative integer, got ${n}`);
    return n;
  });
}

function readPortRef(raw: unknown, path: string): PortRef {
  const e = reqRecord(raw, path);
  const node = readNodePath(e["node"], at(path, "node"));
  const port = reqString(e["port"], at(path, "port"));
  const index = readIndex(e["index"], at(path, "index"));
  return index ? { node, port, index } : { node, port };
}

function readArc(raw: unknown, path: string): ArcRef {
  const a = reqRecord(raw, path);
  return { from: readPortRef(a["from"], at(path, "from")), to: readPortRef(a["to"], at(path, "to")) };
}
