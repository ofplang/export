/**
 * What a plan path names in the workflow, through structured nodes.
 *
 * A plan names every invocation (`[Each, 2, Look]`, §6.3); the workflow has
 * one node for all of them. A branch's arm adds nothing to the path — an
 * atomic arm runs at the branch's own path, a composite arm's nodes are under
 * it — so which arm a path is in is read off the process that ran, where the
 * arms do not tell it apart by their nodes (workflow spec §20, SPEC §6.3).
 *
 * Nothing here guesses: a path that two arms could both own, with no process
 * to tell them apart, resolves to nothing.
 */

import { sourcePath, type NodePath } from "./common";
import type { NodeInvocation, OutputMode, PortDecl, ProcessDef, Workflow } from "./workflow";

export interface Resolved {
  /** The node the path ends at. */
  readonly invocation: NodeInvocation;
  /** The process that runs there: the node's, or for a branch the arm's. */
  readonly process: string;
  readonly def: ProcessDef | undefined;
  /** Where the path ends in a branch's arm, which one. */
  readonly arm?: "then" | "else";
}

/** The arms of a branch, as process names. An omitted `else` is the identity arm and runs nothing. */
export function armsOf(inv: NodeInvocation): { arm: "then" | "else"; process: string }[] {
  if (!inv.arms) return [];
  const out: { arm: "then" | "else"; process: string }[] = [{ arm: "then", process: inv.arms.then }];
  if (inv.arms.else !== undefined) out.push({ arm: "else", process: inv.arms.else });
  return out;
}

/**
 * Walk a plan path (positions and a gate's tail ignored, `sourcePath`) from
 * the entry composite down to the node it ends at. `process`, where known,
 * picks a branch's atomic arm. Undefined where the path leaves the workflow,
 * or is in a branch whose arms cannot be told apart.
 */
export function resolvePath(wf: Workflow, path: NodePath, process?: string): Resolved | undefined {
  const ids = sourcePath(path);
  let container: ProcessDef | undefined = wf.processes[wf.entry];
  let found: Resolved | undefined;
  for (let i = 0; i < ids.length; i++) {
    if (container?.kind !== "composite") return undefined;
    const inv = container.body.nodes.find((n) => n.id === ids[i]);
    if (!inv) return undefined;

    if (inv.kind !== "branch") {
      found = { invocation: inv, process: inv.process, def: wf.processes[inv.process] };
      container = found.def;
      continue;
    }

    const arms = armsOf(inv).map((a) => ({ ...a, def: wf.processes[a.process] }));
    if (i === ids.length - 1) {
      // The path ends at the branch: an atomic arm runs here. Which one is the
      // process that ran; without it, only a branch with one atomic arm says.
      const atomic = arms.filter((a) => a.def?.kind === "atomic");
      const pick = process !== undefined ? atomic.filter((a) => a.process === process) : atomic;
      if (pick.length !== 1) return process === undefined && atomic.length > 1 ? branchOnly(inv, arms) : undefined;
      return { invocation: inv, process: pick[0]!.process, def: pick[0]!.def, arm: pick[0]!.arm };
    }
    // The path goes on into a composite arm: the one whose body has the next node.
    const next = ids[i + 1];
    const into = arms.filter((a) => a.def?.kind === "composite" && a.def.body.nodes.some((n) => n.id === next));
    if (into.length !== 1) return undefined;
    found = { invocation: inv, process: into[0]!.process, def: into[0]!.def, arm: into[0]!.arm };
    container = found.def;
  }
  return found;
}

/**
 * A branch whose arms are both atomic, asked for without a process: the node
 * is known, the arm is not. Its ports are the arms' common ones (§20), so the
 * `then` arm's declarations stand for both — the arm itself is left unsaid.
 */
function branchOnly(inv: NodeInvocation, arms: { process: string; def: ProcessDef | undefined }[]): Resolved {
  return { invocation: inv, process: arms[0]!.process, def: arms[0]!.def };
}

/**
 * The ports a node exposes, by name and declared type, as the workflow spec
 * shapes them (§17-§21): a plain node its process's; a `map` every output of
 * its target collected into an Array; a `fold` / `do_while` its carries and
 * what its `outputs` collect (and a `do_while` its `exhausted`); a `branch` the
 * outputs common to both arms — its `outputs` section, or by default the
 * Object-bearing ones (§20.3).
 */
export function nodePorts(
  wf: Workflow,
  inv: NodeInvocation,
): { inputs: Record<string, string>; outputs: Record<string, string> } {
  const types = (ports: Readonly<Record<string, PortDecl>> | undefined): Record<string, string> =>
    Object.fromEntries(Object.entries(ports ?? {}).map(([p, d]) => [p, d.type]));
  const array = (t: string): string => `Array<${t}>`;

  if (inv.kind === "branch") {
    const arms = armsOf(inv).map((a) => wf.processes[a.process]);
    const first = arms[0];
    const inputs: Record<string, string> = {};
    for (const port of Object.keys(inv.args)) inputs[port] = first?.inputs[port]?.type ?? "";
    const outputs: Record<string, string> = {};
    const out = types(first?.outputs);
    if (inv.outputs) {
      for (const [port, mode] of Object.entries(inv.outputs)) if (mode === "common") outputs[port] = out[port] ?? "";
    } else {
      // §20.3: by default the Object-bearing outputs, which both arms have.
      // An omitted `else` returns each Object-bearing argument as it came.
      for (const [port, t] of Object.entries(out)) if (isObjectType(t, wf)) outputs[port] = t;
    }
    return { inputs, outputs };
  }

  const def = wf.processes[inv.process];
  const ins = types(def?.inputs);
  const outs = types(def?.outputs);
  if (inv.kind === "invoke") return { inputs: ins, outputs: outs };

  const inputs: Record<string, string> = {};
  for (const [port, t] of Object.entries(ins)) inputs[port] = port in inv.each ? array(t) : t;
  if (inv.kind === "map") return { inputs, outputs: Object.fromEntries(Object.entries(outs).map(([p, t]) => [p, array(t)])) };

  const outputs: Record<string, string> = {};
  const mode = (port: string): OutputMode | undefined =>
    inv.outputs ? inv.outputs[port] : port in inv.carry ? "carry" : undefined;
  for (const [port, t] of Object.entries(outs)) {
    const m = mode(port);
    if (m === "carry") outputs[port] = t;
    else if (m === "collect") outputs[port] = array(t);
  }
  if (inv.kind === "do_while") outputs["exhausted"] = "Bool";
  return { inputs, outputs };
}

/** Whether a declared type carries an Object (`carriesObject`, without the graph's import cycle). */
function isObjectType(type: string, wf: Pick<Workflow, "types">): boolean {
  const names = type.replace(/\[[^\]]*\]/g, "").match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return names.some((name) => wf.types[name]?.domain === "object");
}
