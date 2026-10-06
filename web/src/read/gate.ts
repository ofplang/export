/**
 * Feature gate — can this viewer render the document faithfully?
 *
 * This is not validation. `ofplang-validate` decides whether a document is
 * valid v0; this decides whether *this viewer* understands it. The workflow
 * spec draws exactly that line: "If a document requires a feature that is
 * defined by v0 but not supported by a particular implementation, the document
 * is valid v0 but unsupported by that implementation" (§4.4).
 *
 * The viewer supports **none** of the optional v0 features listed below. Saying
 * so plainly is the point — a silently wrong picture is worse than a refusal.
 *
 * The decision rests on what the document *requires*, derived from its body,
 * not on what it declares. `features` may over-declare (§4.1: extra features
 * "are allowed and do not change the semantics"), so a document that lists
 * `node_map` but never uses one still renders. The declared set is reported
 * alongside, because the mismatch is worth showing a human.
 */

import { at, isRecord, ReadError } from "./coerce";

export const V0_FEATURES = [
  "node_map",
  "node_fold",
  "node_do_while",
  "node_branch",
  "generic_processes",
  "python_script_processes",
] as const;

export type FeatureName = (typeof V0_FEATURES)[number];

/** Structured node `kind` (§17-§20) → the feature it requires. */
const NODE_KIND_FEATURE: Readonly<Record<string, FeatureName>> = {
  map: "node_map",
  fold: "node_fold",
  do_while: "node_do_while",
  branch: "node_branch",
};

export interface Finding {
  /** What was found, in the document's own vocabulary. */
  readonly what: string;
  /** Where, as a dotted path into the document. */
  readonly at: string;
  /** What it means for the viewer, in one sentence for a human. */
  readonly why: string;
}

export interface GateReport {
  /** True when the viewer can render this document as written. */
  readonly supported: boolean;
  /** The document's own `features` list, verbatim. Informational (§4.1). */
  readonly declared: readonly string[];
  /** Features the body actually requires — this is what `supported` rests on. */
  readonly derived: readonly FeatureName[];
  /** Every blocking construct, with its location. */
  readonly findings: readonly Finding[];
  /** True when the document still holds `$import` and must be expanded first. */
  readonly needsExpansion: boolean;
}

/** Inspect a parsed workflow document. Never throws: a malformed document is
 *  the reader's problem to report, not the gate's. */
export function gateWorkflow(raw: unknown): GateReport {
  const findings: Finding[] = [];
  const derived = new Set<FeatureName>();

  const imports = findImports(raw, "");
  for (const path of imports) {
    findings.push({
      what: "$import",
      at: path,
      why: "the document has not been expanded; run it through ofplang-validate's expand() first (§3)",
    });
  }

  const doc = isRecord(raw) ? raw : {};
  const declared = Array.isArray(doc["features"])
    ? doc["features"].filter((f): f is string => typeof f === "string")
    : [];

  const processes = isRecord(doc["processes"]) ? doc["processes"] : {};
  for (const [name, def] of Object.entries(processes)) {
    if (!isRecord(def)) continue;
    const base = at("processes", name);

    if (def["type_params"] !== undefined) {
      derived.add("generic_processes");
      findings.push({
        what: "a generic process (`type_params`)",
        at: at(base, "type_params"),
        why: "the viewer does not instantiate generics, so it cannot say what this process's ports carry (§8)",
      });
    }
    if (def["script"] !== undefined) {
      derived.add("python_script_processes");
      findings.push({
        what: "an inline script process (`script`)",
        at: at(base, "script"),
        why: "shown as an ordinary atomic step; its code is not read (§22)",
      });
    }

    const body = isRecord(def["body"]) ? def["body"] : undefined;
    const nodes = body && Array.isArray(body["nodes"]) ? body["nodes"] : [];
    nodes.forEach((n, i) => {
      if (!isRecord(n)) return;
      const kind = n["kind"];
      if (kind === undefined) return; // a plain node invocation — the supported case
      const where = at(at(at(base, "body"), "nodes"), i);
      const feature = typeof kind === "string" ? NODE_KIND_FEATURE[kind] : undefined;
      if (feature) {
        derived.add(feature);
        findings.push({
          what: `a structured node (\`kind: ${kind}\`)`,
          at: where,
          why: "the viewer draws source structure only and cannot show what this expands to (§17-§20)",
        });
      } else {
        findings.push({
          what: `an unrecognised node kind (\`kind: ${String(kind)}\`)`,
          at: where,
          why: "not a v0 structured node the viewer knows; it is skipped rather than guessed at",
        });
      }
    });
  }

  return {
    supported: findings.length === 0,
    declared,
    derived: [...derived].sort(),
    findings,
    needsExpansion: imports.length > 0,
  };
}

/** `$import` may appear anywhere a mapping may (§3.2), so this walks the tree. */
function findImports(node: unknown, path: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown, p: string): void => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, at(p, i)));
      return;
    }
    if (!isRecord(v)) return;
    for (const [k, child] of Object.entries(v)) {
      if (k === "$import") out.push(at(p, k));
      else walk(child, at(p, k));
    }
  };
  walk(node, path);
  return out;
}

/**
 * A document the viewer will not draw at all. Still a `ReadError`, so a caller
 * that only asks "did it read?" gets the right answer; a caller that asks why
 * gets the findings.
 */
export class UnsupportedError extends ReadError {
  constructor(readonly findings: readonly Finding[]) {
    super(findings[0]?.at ?? "", `${findings.map((f) => f.what).join(", ")} — ${findings[0]?.why ?? ""}`);
    this.name = "UnsupportedError";
  }
}

/**
 * Inspect a parsed execution document. Never throws, like `gateWorkflow`.
 *
 * The one thing refused is a joint plan (§6.11, design.md D42): several
 * workflows scheduled together as jobs. Every view here is built on a single
 * workflow — one graph, one node-path namespace, one `meta.workflow` — so a
 * roster is not a field to learn but a different shape of document, and
 * drawing it as one workflow would pair activities with the wrong graph.
 * Any one of the three marks is enough: the roster, a `job` on an activity,
 * or `meta.workflow` given as a list.
 */
export function gateDocument(raw: unknown): Finding[] {
  if (!isRecord(raw)) return [];
  const why =
    "a joint plan schedules several workflows together (§6.11); this viewer draws one workflow at a time";
  const findings: Finding[] = [];
  if (raw["jobs"] !== undefined && raw["jobs"] !== null)
    findings.push({ what: "a joint plan (`jobs`)", at: "jobs", why });
  const activities = Array.isArray(raw["activities"]) ? raw["activities"] : [];
  const tagged = activities.findIndex((a) => isRecord(a) && a["job"] !== undefined);
  if (tagged >= 0)
    findings.push({ what: "activities tagged with a `job`", at: at(at("activities", tagged), "job"), why });
  const meta = raw["meta"];
  if (isRecord(meta) && Array.isArray(meta["workflow"]))
    findings.push({ what: "more than one workflow in `meta.workflow`", at: "meta.workflow", why });
  return findings;
}

/** One line a human can act on, for the banner. */
export function gateSummary(r: GateReport): string {
  if (r.supported) return "";
  if (r.needsExpansion)
    return "This workflow still has $import in it. Expand it first — ofp-validate can do that — then load the result.";
  const names = [...new Set(r.findings.map((f) => f.what))];
  return `This viewer cannot draw ${names.join(", ")} faithfully, so parts of the graph are left out.`;
}
