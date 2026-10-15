/** The right-hand panel: the plan at a glance, or the selected activity. */

import { arcKey, pathKey, pathText, type NodePath, type PortRef } from "../model/common";
import type { SpotTree } from "../model/document";
import { annotate } from "../model/annotate";
import { activitiesOn, findNode, type GraphNode } from "../model/graph";
import { tracingOf, type ObjectTrace, type SegmentKind } from "../model/objects";
import { accessesDevices } from "../model/scene";
import type { Activity } from "../model/document";
import type { Scene } from "../model/scene";
import { formatDuration, unitAbbrev } from "../layout/scale";
import { activityLabel, decisionText } from "../layout/gantt";

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const dl = (rows: readonly (readonly [string, unknown])[]): string =>
  `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;

const block = (title: string, body: string): string => `<div><h3>${esc(title)}</h3>${body}</div>`;

export function renderInspector(
  scene: Scene,
  selected: number | undefined,
  datasetBlurb: string,
  within?: ObjectTrace,
): string {
  if (selected === undefined) return overview(scene, datasetBlurb);
  // An activity picked within an Object (D62) says which Object, and the way back.
  const context = within
    ? `<div class="note">Part of the life of <b>${esc(within.label)}</b> — Esc, or its lane's label, for the whole Object.</div>`
    : "";
  return context + detail(scene, selected);
}

function overview(scene: Scene, blurb: string): string {
  const { doc, metrics, unit } = scene;
  const obj = doc.objective;
  const fmtObjective = (): string => {
    if (!obj) return "—";
    const kinds = Array.isArray(obj.kind) ? obj.kind : [obj.kind];
    const values = Array.isArray(obj.value) ? obj.value : obj.value === undefined ? [] : [obj.value];
    return kinds.map((k, i) => `${k} = ${values[i] ?? "?"}`).join(", ");
  };

  const out: string[] = [];
  if (blurb) out.push(block("Dataset", `<div class="note">${esc(blurb)}</div>`));

  out.push(
    block(
      "Solve",
      dl([
        ["outcome", doc.outcome ?? "—"],
        ["objective", fmtObjective()],
        ["makespan", formatDuration(metrics.makespan, unit)],
        ...(typeof doc.now === "number"
          ? ([["now", formatDuration(doc.now, unit)]] as const)
          : []),
      ]),
    ),
  );

  const counts = metrics.counts;
  out.push(
    block(
      "Activities",
      dl(
        (["processing", "transport", "relay", "replenishment", "decision", "gate", "reservation"] as const)
          .filter((k) => counts[k] > 0)
          .map((k) => [k, counts[k]] as const),
      ),
    ),
  );

  if (metrics.busiest.length) {
    const bars = metrics.busiest
      .map(
        (m) =>
          `<div class="ubar"><span class="t" title="${esc(m.id)}">${esc(m.id)}</span>` +
          `<span class="track"><span class="fill ${esc(m.kind)}" style="width:${Math.round(m.occupancy * 100)}%"></span></span>` +
          `<span class="p num">${Math.round(m.occupancy * 100)}%</span></div>`,
      )
      .join("");
    out.push(
      block(
        "Occupancy",
        `<div class="util">${bars}</div>` +
          `<div class="note" style="margin-top:8px">Share of the run each machine is held. A move holds its ` +
          `transporter and the devices at both ends, so those count too; material merely resting on a ` +
          `device does not.</div>`,
      ),
    );
  }

  if (doc.interface) {
    const rows = [
      ...Object.entries(doc.interface.inputs).map(([p, s]) => [`in · ${p}`, spotTreeText(s)] as const),
      ...Object.entries(doc.interface.outputs ?? {}).map(([p, s]) => [`out · ${p}`, spotTreeText(s)] as const),
    ];
    if (rows.length)
      out.push(block("Boundary", dl(rows) + `<div class="note" style="margin-top:8px">Where the workflow's own material starts and ends up.</div>`));
  }

  // What the run has said about the expansion (§6.13): the rest of the plan
  // stands on assumptions, which its decisions name (§6.14).
  const ex = doc.expansion;
  if (ex && (ex.arms.length || ex.loops.length || ex.lengths.length)) {
    const rows: (readonly [string, unknown])[] = [
      ...ex.arms.map((x) => [pathText(x.node), `arm ${x.arm}`] as const),
      ...ex.loops.map((x) => [pathText(x.node), `${x.count} invocation${x.count === 1 ? "" : "s"}${x.ended ? ", ended" : ", going on"}`] as const),
      ...ex.lengths.map((x) => [`${x.node.length ? pathText(x.node) : "inputs"}.${x.port}${x.index ? `[${x.index.join(",")}]` : ""}`, `${x.length} long`] as const),
    ];
    out.push(
      block(
        "Decided",
        dl(rows) +
          `<div class="note" style="margin-top:8px">What the run has stated about the branches, loops and lists ` +
          `(§6.13). Anything not stated is assumed by the plan, and its decision says so.</div>`,
      ),
    );
  }

  if (doc.occupied?.length) {
    out.push(
      block(
        "Occupied",
        dl(doc.occupied.map((o) => [o.spot, `since ${formatDuration(o.since, unit)}`] as const)) +
          `<div class="note" style="margin-top:8px">Spots a stopped job left held. The plan may not use them; ` +
          `what is on them is not said (§6.12).</div>`,
      ),
    );
  }

  if (scene.resources.length) {
    // The question a plan with refills raises is why this many and why here.
    // Where it got to at its lowest is the answer: a stock that reaches zero
    // was the constraint, one that never drops far was not.
    const rows = scene.resources
      .map((r) => {
        const cap = r.capacity === undefined ? "" : ` / ${r.capacity}`;
        const drained = r.low === 0 ? ' <span class="warn">ran dry</span>' : "";
        return (
          `<div class="ubar res"><span class="t" title="${esc(r.ref)}">${esc(r.ref)}</span>` +
          `<span class="p num">${r.start} → ${r.low}${drained} → ${r.end}${cap}</span></div>`
        );
      })
      .join("");
    const refills = scene.resources.reduce((n, r) => n + r.refills, 0);
    out.push(
      block(
        "Stock",
        `<div class="util">${rows}</div>` +
          `<div class="note" style="margin-top:8px">Level at the start, at its lowest once the run was ` +
          `under way, and at the end, replayed from the ` +
          `starting stock through ${refills === 1 ? "one refill" : `${refills} refills`} and what each step used.</div>`,
      ),
    );
  }

  return out.join("");
}

function detail(scene: Scene, index: number): string {
  const a = scene.activities[index];
  if (!a) return "";
  const unit = scene.unit;
  const out: string[] = [];

  out.push(`<div><h3>${esc(a.kind)}</h3><div class="lead">${esc(activityLabel(a))}</div></div>`);

  const timing: (readonly [string, unknown])[] = [
    ["start", formatDuration(a.start, unit)],
    ["end", formatDuration(a.end, unit)],
    ["duration", formatDuration(a.end - a.start, unit)],
  ];
  if (a.status !== "pending") timing.push(["status", a.status]);
  out.push(block("Timing", dl(timing)));

  switch (a.kind) {
    case "processing": {
      const rows: (readonly [string, unknown])[] = [
        ["process", a.process],
        ["mode", a.mode],
        ["node", pathKey(a.node)],
      ];
      if (a.devices?.length) rows.push(["devices", a.devices.join(", ")]);
      if (!accessesDevices(a, scene.env)) rows.push(["device access", "none — the material rests there (§4.4.2)"]);
      for (const [p, s] of Object.entries(a.inputSpots ?? {})) rows.push([`in · ${p}`, s]);
      for (const [p, s] of Object.entries(a.outputSpots ?? {})) rows.push([`out · ${p}`, s]);
      for (const [r, n] of Object.entries(a.consumption ?? {})) rows.push([`uses · ${r}`, n]);
      out.push(block("Step", dl(rows)));
      break;
    }
    case "transport":
      out.push(
        block(
          "Move",
          dl([
            ["from", a.fromSpot],
            ["to", a.toSpot],
            // §6.4: omitted for a same-spot move, null on a route that needs none.
            ["transporter", a.transporter ?? (a.fromSpot === a.toSpot ? "— (same spot, a no-op)" : "— (none needed on this route)")],
            ...(a.seq !== undefined ? ([["leg", a.seq]] as const) : []),
          ]),
        ),
      );
      break;
    case "relay":
      out.push(block("Junction", dl([["spot", a.spot], ["leg", a.seq]])));
      break;
    case "replenishment":
      out.push(
        block(
          "Refill",
          dl([
            ["device", a.device],
            ["replenisher", a.replenisher],
            ...Object.entries(a.amounts).map(([r, n]) => [`+ ${r}`, n] as const),
          ]),
        ),
      );
      break;
    case "decision":
      out.push(
        block(
          "Decision",
          dl([
            ["node", pathText(a.node)],
            ["decides", decisionText(a)],
            ["reads", portText(a.condition)],
            ["stands", a.assumed ? "assumed — the run has not said yet" : "stated by the run"],
          ]) +
            `<div class="note" style="margin-top:8px">The moment the run reads the value and decides (§6.14). ` +
            `Nothing the outcome decides starts before it.</div>`,
        ),
      );
      break;
    case "gate":
      out.push(
        block(
          "Gate",
          dl([["node", pathText(a.node)], ["spot", a.spot ?? "— (Pure Data)"]]) +
            `<div class="note" style="margin-top:8px">Where the region's outcome leaves it, whichever way it was ` +
            `decided; what follows starts from here (§6.15).</div>`,
        ),
      );
      break;
    case "reservation":
      out.push(
        block(
          "Kept",
          dl([["for", pathText(a.node)], ...a.spots.map((sp) => ["spot", sp] as const)]) +
            `<div class="note" style="margin-top:8px">Spots kept for the region while its outcome is open, so ` +
            `the plan holds whichever way it turns out (§6.16). Devices are not kept.</div>`,
        ),
      );
      break;
  }
  if (scene.assumed.has(index))
    out.push(
      block(
        "Assumed",
        `<div class="note">This stands on an outcome the plan only assumes; the run may decide otherwise, ` +
          `and then it does not happen (§6.14).</div>`,
      ),
    );

  if (a.kind === "transport" || a.kind === "relay") {
    const end = (e: PortRef): string => (e.node.length ? portText(e) : `⟨interface⟩ . ${e.port}${indexText(e.index)}`);
    const legs = scene.byArc.get(arcKey(a.arc)) ?? [];
    out.push(
      block(
        "Object arc",
        dl([
          ["from", end(a.arc.from)],
          ["to", end(a.arc.to)],
          ["legs", legs.length],
        ]) +
          `<div class="note" style="margin-top:8px">Every leg of a multi-hop move carries this same arc — selecting one selects the whole journey.</div>`,
      ),
    );
  }

  return out.join("");
}

/** A selected connection in the graph: what it joins, and what the plan moves along it. */
export function renderEdgeDetail(
  label: string,
  carries: string,
  object: boolean,
  scene: Scene | undefined,
  moves: readonly number[],
): string {
  const out = [`<div><h3>connection</h3><div class="lead">${esc(label)}</div></div>`];
  // `carries` names the declared type as well as its kind: `Plate (an Object)`, `Float (Pure Data)`.
  const rows: (readonly [string, unknown])[] = [["carries", carries]];
  if (scene) rows.push(["moves", object ? moves.length : "— (Pure Data is a dependency, not a move)"]);
  out.push(block("Dataflow", dl(rows)));
  if (scene && moves.length) {
    const unit = scene.unit;
    const lines = moves
      .map((i) => scene.activities[i]!)
      .map((a) => `${formatDuration(a.start, unit)} – ${formatDuration(a.end, unit)} · ${activityLabel(a)}`);
    out.push(block("In the plan", `<div class="note">${lines.map(esc).join("<br>")}</div>`));
  }
  return out.join("");
}

/** What each stretch of a lifeline is called, in the panel and on hover. */
const SEGMENT_WORD: Readonly<Record<SegmentKind, string>> = {
  processing: "in a step",
  resting: "resting (device free)",
  waiting: "waiting on a spot",
  transport: "moving",
  relay: "at a relay",
  gate: "through a gate",
};

/** A selected Object: where it comes from, where it ends, and everything between. */
export function renderObjectDetail(scene: Scene, t: ObjectTrace): string {
  const unit = scene.unit;
  const first = t.segments[0]!;
  const last = t.segments[t.segments.length - 1]!;
  const out = [`<div><h3>object</h3><div class="lead">${esc(t.label)}</div></div>`];

  const port = (node: NodePath, p: string): string => `${pathText(node)}.${p}`;
  out.push(
    block(
      "Life",
      dl([
        ["type", t.type || "—"],
        ["appears", t.origin.kind === "create" ? `created by ${port(t.origin.node, t.origin.port)}` : `entry input ${t.origin.port}`],
        ["ends", t.fate.kind === "consume" ? `consumed by ${port(t.fate.node, t.fate.port)}` : `delivered as output ${t.fate.port}`],
        ["from", formatDuration(first.start, unit)],
        ["to", formatDuration(last.end, unit)],
        ["moves", t.arcs.length],
      ]),
    ),
  );

  // Where its time went. Instants (a relay) take none, and are not listed.
  const spent = new Map<SegmentKind, number>();
  for (const s of t.segments) spent.set(s.kind, (spent.get(s.kind) ?? 0) + (s.end - s.start));
  const order: SegmentKind[] = ["processing", "resting", "waiting", "transport"];
  const rows = order.filter((k) => (spent.get(k) ?? 0) > 0).map((k) => [SEGMENT_WORD[k], formatDuration(spent.get(k)!, unit)] as const);
  if (rows.length) out.push(block("Time", dl(rows)));

  const lines = t.segments.map((s) => {
    const a = s.activity === undefined ? undefined : scene.activities[s.activity];
    const what = a ? activityLabel(a) : s.from ?? "";
    const where = a && a.kind === "processing" && s.from ? ` · ${s.from}` : "";
    return `${formatDuration(s.start, unit)} – ${formatDuration(s.end, unit)} · ${SEGMENT_WORD[s.kind]} · ${what}${where}`;
  });
  out.push(block("Journey", `<div class="note">${lines.map(esc).join("<br>")}</div>`));
  return out.join("");
}

/** The hover card for a wait, which is no activity: where, and for how long. */
export function waitTooltip(scene: Scene, object: string, start: number, end: number): string {
  const tracing = tracingOf(scene);
  const t = tracing.ok ? tracing.traces.find((x) => x.id === object) : undefined;
  const spot = t?.segments.find((s) => s.kind === "waiting" && s.start === start && s.end === end)?.from ?? "";
  const unit = unitAbbrev(scene.unit);
  const lines = [`${start} – ${end} ${unit}  (${end - start})`];
  if (t) lines.push(t.label);
  return `<div class="tt">${esc(`waiting on ${spot}`)}</div><div class="tl">${lines.map(esc).join("<br>")}</div>`;
}

/** A boundary port's spots: one, or a list nested as its Array is (§6.8). */
const spotTreeText = (t: SpotTree): string => (typeof t === "string" ? t : `[${t.map(spotTreeText).join(", ")}]`);

const indexText = (index: readonly number[] | undefined): string => (index ? `[${index.join(",")}]` : "");

/** One end of an arc or a decision's condition: `Each/0/Look . dirty`. */
const portText = (e: PortRef): string => `${e.node.length ? pathText(e.node) : "inputs"} . ${e.port}${indexText(e.index)}`;

/** A literal as written: a string quoted, a number or a list as it reads. */
const literal = (v: unknown): string => JSON.stringify(v) ?? String(v);

/** The hover card. */
export function tooltipFor(scene: Scene, index: number): string {
  const a = scene.activities[index];
  if (!a) return "";
  const unit = unitAbbrev(scene.unit);
  const lines: string[] = [`${a.start} – ${a.end} ${unit}  (${a.end - a.start})`];
  if (a.kind === "processing")
    lines.push(
      `${a.process} · mode ${a.mode}${a.devices?.length ? ` · ${a.devices.join(", ")}` : ""}` +
        (accessesDevices(a, scene.env) ? "" : " · resting"),
    );
  if (a.kind === "transport")
    lines.push(
      `${a.fromSpot} → ${a.toSpot}${a.transporter ? ` · ${a.transporter}` : a.fromSpot === a.toSpot ? " · same spot" : " · no transporter"}`,
    );
  if (a.kind === "relay") lines.push(`waiting at ${a.spot}`);
  if (a.kind === "replenishment") lines.push(`${a.device} · ${a.replenisher}`);
  if (a.kind === "decision") lines.push(`${decisionText(a)} · reads ${portText(a.condition)}`);
  if (a.kind === "gate" && a.spot) lines.push(`on ${a.spot}`);
  if (a.kind === "reservation") lines.push(`keeps ${a.spots.join(", ")}`);
  if (scene.assumed.has(index)) lines.push("assumed — may not happen");
  if (a.status !== "pending") lines.push(`status: ${a.status}`);
  return `<div class="tt">${esc(activityLabel(a))}</div><div class="tl">${lines.map(esc).join("<br>")}</div>`;
}

export function statusLine(scene: Scene, selected: number | undefined): string {
  if (selected === undefined) return "Nothing selected — click a bar";
  const a = scene.activities[selected];
  return a ? `Selected · ${activityLabel(a)}` : "Nothing selected";
}

export type { Activity };


/* ── with no plan loaded ─────────────────────────────────────────────────
   The graph stands on its own: a workflow can be read before anything has
   been scheduled from it, and that is when the feature gate is most useful. */

export function renderWorkflowOverview(graph: GraphNode, blurb: string): string {
  const out: string[] = [];
  if (blurb) out.push(block("Loaded", `<div class="note">${esc(blurb)}</div>`));

  out.push(
    block(
      "Workflow",
      `<div class="lead">${esc(graph.process)}</div>` +
        dl([
          ["atomic steps", graph.atomicCount],
          ["top-level nodes", graph.children.length],
          ["entry inputs", Object.keys(graph.inputs).length],
          ["entry outputs", Object.keys(graph.returns).length],
        ]),
    ),
  );

  out.push(
    block(
      "No plan",
      `<div class="note">Nothing has been scheduled from this workflow yet. ` +
        `Run <code>ofp-schedule schedule</code> on it and drop the plan here to see when each step runs.</div>`,
    ),
  );
  return out.join("");
}

/** A box in the graph: what it is, and what it accounts for in the plan. */
export function renderNodeDetail(graph: GraphNode, key: string, scene?: Scene): string {
  const node = findNode(graph, key);
  if (!node) return "";
  const out: string[] = [];

  const what =
    node.structure === "invoke" ? `${node.kind} node` : node.structure === "arm" ? `${node.arm} arm` : `${node.structure} node`;
  out.push(`<div><h3>${esc(what)}</h3><div class="lead">${esc(node.key || node.process)}</div></div>`);

  const rows: (readonly [string, unknown])[] = [];
  if (node.structure !== "branch") rows.push(["process", node.process || "— (each argument as it came, §20)"]);
  if (node.structure === "branch") {
    rows.push(["condition", node.condition ?? "a literal"]);
    for (const arm of node.children) rows.push([`${arm.arm} arm`, arm.process || "— (as it came)"]);
  }
  if (node.limit !== undefined) rows.push(["at most", `${node.limit} invocations`]);
  const note = scene ? annotate(scene, graph).get(node.key) : undefined;
  if (note?.invocations !== undefined) rows.push(["invocations", note.invocations]);
  if (note && node.structure === "arm") {
    rows.push(["taken", note.ran ?? 0]);
    if (note.assumed) rows.push(["assumed", `${note.assumed} — the run has not said yet`]);
  }
  if (node.kind === "composite") {
    rows.push(["atomic steps", node.atomicCount], ["nodes inside", node.children.length]);
  }
  out.push(block("Node", dl(rows)));

  if (node.inputs.length || node.outputs.length)
    out.push(
      block(
        "Ports",
        dl([
          // A literal is shown with its port: it has no source to draw a connection from.
          ...node.inputs.map((p) => ["in", p in node.literals ? `${p} = ${literal(node.literals[p])}` : p] as const),
          ...node.outputs.map(
            (p) => ["out", p in node.returnLiterals ? `${p} = ${literal(node.returnLiterals[p])}` : p] as const,
          ),
        ]),
      ),
    );

  if (scene) {
    const under = activitiesOn(scene, graph, node.key);
    const acts = under.map((i) => scene.activities[i]!);
    const steps = acts.filter((a) => a.kind === "processing").length;
    const moves = acts.filter((a) => a.kind === "transport" || a.kind === "relay").length;
    const window =
      acts.length > 0
        ? `${Math.min(...acts.map((a) => a.start))} – ${Math.max(...acts.map((a) => a.end))} ${unitAbbrev(scene.unit)}`
        : "—";
    out.push(
      block(
        "In the plan",
        dl([
          ["steps", steps],
          ["moves", moves],
          ["window", window],
        ]),
      ),
    );
  }

  return out.join("");
}
