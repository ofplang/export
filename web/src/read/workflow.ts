/**
 * Read a workflow — ofplang v0.
 *
 * Plain and structured nodes (`map`, `fold`, `do_while`, `branch`, workflow
 * spec §17-§20). `$import` and generics are the gate's to report
 * (`read/gate.ts`); run it first and show its findings — this reader assumes
 * the document got past it and reads the shape as written.
 */

import { parse as parseYaml } from "yaml";

import type {
  AtomicProcess,
  Binding,
  CompositeProcess,
  NodeInvocation,
  NodeKind,
  ObjectsSection,
  OutputMode,
  PortDecl,
  ProcessDef,
  Workflow,
} from "../model/workflow";
import {
  at,
  isRecord,
  optRecord,
  optString,
  ReadError,
  reqRecord,
  reqString,
  stringList,
  stringMap,
} from "./coerce";

export function readWorkflowText(text: string): Workflow {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ReadError("", `not valid YAML — ${(e as Error).message}`);
  }
  return readWorkflow(raw);
}

export function readWorkflow(raw: unknown): Workflow {
  const doc = reqRecord(raw, "");

  const types: Record<string, { domain: "object" | "data" }> = {};
  for (const [name, def] of Object.entries(optRecord(doc["types"], "types") ?? {})) {
    const d = reqRecord(def, at("types", name));
    const domain = reqString(d["domain"], at(at("types", name), "domain"));
    if (domain !== "object" && domain !== "data")
      throw new ReadError(at(at("types", name), "domain"), `expected object or data, got "${domain}"`);
    types[name] = { domain };
  }

  const processes: Record<string, ProcessDef> = {};
  for (const [name, def] of Object.entries(reqRecord(doc["processes"], "processes"))) {
    processes[name] = readProcess(def, at("processes", name));
  }

  const entry = reqString(doc["entry"], "entry");
  if (!(entry in processes))
    throw new ReadError("entry", `"${entry}" is not one of the declared processes`);

  return {
    specVersion: optString(doc["spec_version"], "spec_version") ?? "0.0",
    types,
    processes,
    entry,
  };
}

function readProcess(raw: unknown, path: string): ProcessDef {
  const p = reqRecord(raw, path);
  const kind = reqString(p["kind"], at(path, "kind"));
  const inputs = readPorts(p["inputs"], at(path, "inputs"));
  const outputs = readPorts(p["outputs"], at(path, "outputs"));

  if (kind === "atomic") {
    const a: { -readonly [K in keyof AtomicProcess]: AtomicProcess[K] } = {
      kind: "atomic",
      inputs,
      outputs,
    };
    const objects = optRecord(p["objects"], at(path, "objects"));
    if (objects) a.objects = readObjects(objects, at(path, "objects"));
    if (p["behavior"] !== undefined) a.behavior = stringList(p["behavior"], at(path, "behavior"));
    return a;
  }

  if (kind === "composite") {
    const body = reqRecord(p["body"], at(path, "body"));
    const bodyPath = at(path, "body");
    const rawNodes = body["nodes"];
    const nodes = (Array.isArray(rawNodes) ? rawNodes : []).map((n, i) =>
      readNode(n, at(at(bodyPath, "nodes"), i)),
    );
    const returns = readSources(body["returns"], at(bodyPath, "returns"));
    const composite: CompositeProcess = {
      kind: "composite",
      inputs,
      outputs,
      body: { nodes, returns: returns.from, returnLiterals: returns.value },
    };
    return composite;
  }

  throw new ReadError(at(path, "kind"), `expected atomic or composite, got "${kind}"`);
}

function readPorts(raw: unknown, path: string): Record<string, PortDecl> {
  const out: Record<string, PortDecl> = {};
  for (const [name, def] of Object.entries(optRecord(raw, path) ?? {})) {
    const d = reqRecord(def, at(path, name));
    out[name] = {
      type: reqString(d["type"], at(at(path, name), "type")),
      // `phase` is optional in practice; the examples always write it.
      phase: optString(d["phase"], at(at(path, name), "phase")) ?? "data",
    };
  }
  return out;
}

function readObjects(o: Record<string, unknown>, path: string): ObjectsSection {
  const out: { -readonly [K in keyof ObjectsSection]: ObjectsSection[K] } = {};
  const map = optRecord(o["map"], at(path, "map"));
  if (map) out.map = stringMap(map, at(path, "map"));
  if (o["consume"] !== undefined) out.consume = stringList(o["consume"], at(path, "consume"));
  if (o["create"] !== undefined) out.create = stringList(o["create"], at(path, "create"));
  if (o["transform"] !== undefined) out.transform = o["transform"];
  return out;
}

function readNode(raw: unknown, path: string): NodeInvocation {
  const n = reqRecord(raw, path);
  const state = readSources(n["state"], at(path, "state"));
  // A literal cannot introduce an Object identity (workflow spec 11.1.1).
  const literal = Object.keys(state.value)[0];
  if (literal !== undefined)
    throw new ReadError(
      at(at(path, "state"), literal),
      "a literal (`value`) is Pure Data and cannot be bound to an Object-bearing port (workflow spec 11.1.1)",
    );
  // workflow spec §11: `state` binds Object-bearing inputs, `bind` Pure Data.
  // (This read `data` until 2026-09-27 — a key the spec does not have, so
  // every Pure Data arc was silently dropped; nothing bundled then had one.)
  const bind = readSources(n["bind"], at(path, "bind"));
  const each = readSources(n["each"], at(path, "each"));
  const carry = readSources(n["carry"], at(path, "carry"));
  const args = readSources(n["args"], at(path, "args"));
  const kind = readKind(n["kind"], at(path, "kind"));

  const out: { -readonly [K in keyof NodeInvocation]: NodeInvocation[K] } = {
    id: reqString(n["id"], at(path, "id")),
    kind,
    // A branch names a process per arm instead (workflow spec 21.0).
    process: kind === "branch" ? "" : reqString(n["process"], at(path, "process")),
    state: state.from,
    data: bind.from,
    // Any section may give a Pure Data input a literal; none of them is drawn.
    literals: { ...each.value, ...carry.value, ...args.value, ...bind.value },
    each: each.from,
    carry: carry.from,
    args: args.from,
  };
  if (kind === "branch") {
    const arm = (key: "then" | "else"): string | undefined => {
      const a = optRecord(n[key], at(path, key));
      return a ? reqString(a["process"], at(at(path, key), "process")) : undefined;
    };
    const then = arm("then");
    if (then === undefined) throw new ReadError(at(path, "then"), "a branch names the process of its `then` arm (workflow spec §20)");
    const otherwise = arm("else");
    out.arms = otherwise === undefined ? { then } : { then, else: otherwise };
  }
  const condition = optRecord(n["condition"], at(path, "condition"));
  if (condition) {
    const c: { from?: string; value?: unknown; output?: string } = {};
    const from = optString(condition["from"], at(at(path, "condition"), "from"));
    const output = optString(condition["output"], at(at(path, "condition"), "output"));
    if (from !== undefined) c.from = from;
    if (output !== undefined) c.output = output;
    if ("value" in condition) c.value = condition["value"];
    out.condition = c;
  }
  const limit = optRecord(n["max_iterations"], at(path, "max_iterations"));
  if (limit) {
    const from = optString(limit["from"], at(at(path, "max_iterations"), "from"));
    out.maxIterations = from !== undefined ? { from } : { value: limit["value"] };
  }
  const outputs = optRecord(n["outputs"], at(path, "outputs"));
  if (outputs) {
    const modes: Record<string, OutputMode> = {};
    for (const [port, spec] of Object.entries(outputs)) {
      const where = at(at(path, "outputs"), port);
      const mode = reqString(reqRecord(spec, where)["mode"], at(where, "mode"));
      if (!(OUTPUT_MODES as readonly string[]).includes(mode))
        throw new ReadError(at(where, "mode"), `expected one of ${OUTPUT_MODES.join(" / ")}, got "${mode}"`);
      modes[port] = mode as OutputMode;
    }
    out.outputs = modes;
  }
  return out;
}

const NODE_KINDS = ["map", "fold", "do_while", "branch"] as const;
const OUTPUT_MODES = ["carry", "collect", "drop", "common"] as const;

/** A node without `kind` is a plain invocation (workflow spec 2.3). */
function readKind(raw: unknown, path: string): NodeKind {
  if (raw === undefined || raw === null) return "invoke";
  const kind = reqString(raw, path);
  if (!(NODE_KINDS as readonly string[]).includes(kind))
    throw new ReadError(path, `expected one of ${NODE_KINDS.join(" / ")}, got "${kind}"`);
  return kind as NodeKind;
}

/**
 * Binding source entries (workflow spec 2.6.6), used by node bindings and
 * composite returns: each is exactly one of `from: "<source>"` or `value:` a
 * literal. The two are kept apart — only a `from` has somewhere to be drawn
 * from. (Until 0.1.3 a `value` was read as a missing `from`, and a workflow
 * with any literal did not open.)
 */
function readSources(
  raw: unknown,
  path: string,
): { from: Record<string, Binding>; value: Record<string, unknown> } {
  const from: Record<string, Binding> = {};
  const value: Record<string, unknown> = {};
  for (const [port, b] of Object.entries(optRecord(raw, path) ?? {})) {
    if (!isRecord(b)) throw new ReadError(at(path, port), "expected a mapping with `from` or `value`");
    const hasFrom = "from" in b;
    const hasValue = "value" in b;
    if (hasFrom === hasValue)
      throw new ReadError(
        at(path, port),
        `expected exactly one of \`from\` or \`value\` (workflow spec 2.6.6), got ${hasFrom ? "both" : "neither"}`,
      );
    if (hasFrom) from[port] = { from: reqString(b["from"], at(at(path, port), "from")) };
    else value[port] = b["value"];
  }
  return { from, value };
}
