/**
 * The application: load a plan, draw it, let someone read it.
 *
 * Four ways in: a bundled dataset named by `?doc=`, files dropped on the
 * window, a share link (`#d=`, design.md D9), and the documents a single-file
 * viewer carries inside it (D48). An external URL (D9 ③) is not built yet.
 * Everything else here is state: which dataset, which view, which panes, what
 * is selected.
 */

import { parse as parseYaml } from "yaml";

import { GANTT_VIEWS, type GanttView } from "./layout/gantt";
import {
  activitiesOn,
  ancestorKeys,
  buildGraph,
  compositeKeys,
  edgeKey,
  moveRoute,
  processAt,
  visibleFor,
  type GraphNode,
} from "./model/graph";
import { tracingOf, type ObjectTrace } from "./model/objects";
import { annotate } from "./model/annotate";
import { arcKey, type NodePath } from "./model/common";
import { accessesDevices, buildScene, sameArc, type Scene } from "./model/scene";
import {
  carriesLabel,
  copyShareLink,
  edgeLabel,
  el,
  escapeHtml,
  placeTip,
  wireGraphPointer,
  wireSplitter,
  type EdgeRef,
} from "./interactions";
import type { ExecutionDocument } from "./model/document";
import type { Environment } from "./model/environment";
import type { Workflow } from "./model/workflow";
import { decodeShare } from "./share";
import {
  gateSummary,
  gateWorkflow,
  readEnvironment,
  readEnvironmentText,
  readExecutionDocument,
  readExecutionDocumentText,
  readWorkflow,
  readWorkflowText,
  ReadError,
  UnsupportedError,
  type Finding,
  type GateReport,
} from "./read";
import { downloadSvg, ganttToSvg } from "./view/export";
import { GUTTER_W, renderGantt, type GanttGeometry } from "./view/gantt";
import { renderGraph } from "./view/graph";
import {
  renderInspector,
  renderEdgeDetail,
  renderNodeDetail,
  renderObjectDetail,
  renderWorkflowOverview,
  statusLine,
  tooltipFor,
  waitTooltip,
} from "./view/inspector";
import { formatDuration } from "./layout/scale";

interface DatasetIndexEntry {
  readonly id: string;
  readonly label: string;
  readonly blurb: string;
  readonly origin: string;
  readonly activities: number;
}

interface DatasetPayload {
  readonly id: string;
  readonly label: string;
  readonly blurb: string;
  readonly source: { plan: string; workflow: string | null; environment: string | null };
  readonly plan: unknown;
  readonly workflow: unknown;
  readonly environment: unknown;
}

/**
 * Which panes are on screen (design.md D46). One template serves all three:
 * a page made to show one workflow should not carry an empty plan pane, and
 * someone reading a long plan may want the whole height for it.
 */
type Layout = "split" | "workflow" | "plan";

const LAYOUTS: readonly { id: Layout; label: string; hint: string }[] = [
  { id: "split", label: "Both", hint: "the workflow above, the plan below" },
  { id: "workflow", label: "Workflow", hint: "the workflow graph on its own" },
  { id: "plan", label: "Plan", hint: "the execution plan on its own" },
];

const isLayout = (v: unknown): v is Layout => LAYOUTS.some((l) => l.id === v);

/** What is picked, in whichever pane the person picked it. */
type Selection =
  | { kind: "activity"; index: number }
  /**
   * An Object, picked in the Object view (design.md D58-2) — and, once it is
   * picked, one of its activities within it (D62): the lane stays lit and
   * the panel shows that activity.
   */
  | { kind: "object"; id: string; index?: number }
  | { kind: "node"; key: string }
  | ({ kind: "edge" } & EdgeRef);

interface State {
  index: DatasetIndexEntry[];
  scene?: Scene;
  graph?: GraphNode;
  expanded: Set<string>;
  blurb: string;
  source: string;
  gate?: GateReport;
  /** Why a plan that was given is not drawn (D42) — absent when it was, or when none was given. */
  refused?: readonly Finding[];
  view: GanttView;
  zoom: number;
  graphZoom: number;
  labels: boolean;
  selected?: Selection;
  geometry?: GanttGeometry;
  split: number;
  /** A layout the person chose. Absent means "decided by what was loaded". */
  layout?: Layout;
  /** The details pane as set (D70). Absent means "as the width allows". */
  details?: "show" | "hide";
  /** Kept so a share link can carry exactly what was loaded. */
  raw?: { plan: unknown; workflow: unknown; environment: unknown };
}

const state: State = {
  index: [],
  expanded: new Set(),
  blurb: "",
  source: "",
  view: "device",
  zoom: 1,
  graphZoom: 1,
  labels: true,
  split: 42,
};

/* ── what lights up ─────────────────────────────────────────────────────
   One selection, two panes. An activity names a node path, and the box that
   stands for it may be an ancestor if that ancestor is closed (D11); a node
   stands for everything beneath it. Both directions are lookups into indices
   the scene already built. */

function litActivities(): Set<number> {
  const scene = state.scene;
  const sel = state.selected;
  const out = new Set<number>();
  if (!scene || !sel) return out;

  if (sel.kind === "activity") {
    for (const i of sameArc(scene, sel.index)) out.add(i);
    return out;
  }
  if (sel.kind === "object") {
    for (const i of selectedTrace()?.activities ?? []) out.add(i);
    return out;
  }
  if (sel.kind === "edge") {
    for (const i of movesOn(sel)) out.add(i);
    return out;
  }
  if (state.graph) for (const i of activitiesOn(scene, state.graph, sel.key)) out.add(i);
  return out;
}

interface Highlight {
  readonly lit: Set<string>;
  readonly onPath: Set<string>;
  /** The single connection a selected move serves, if that is the selection. */
  readonly arc?: { fromKey: string; fromPort: string; toKey: string; toPort: string };
  /** The box whose internal dataflow to trace, if that is the selection. */
  readonly subtree?: string;
  /** Every connection a selected Object runs along, as `edgeKey`s. */
  readonly edges?: Set<string>;
}

/** The selected Object's lifeline, if an Object is the selection and it traces. */
function selectedTrace(): ObjectTrace | undefined {
  const scene = state.scene;
  const sel = state.selected;
  if (!scene || sel?.kind !== "object") return undefined;
  const tracing = tracingOf(scene);
  return tracing.ok ? tracing.traces.find((t) => t.id === sel.id) : undefined;
}

function litNodes(): Highlight {
  const lit = new Set<string>();
  const onPath = new Set<string>();
  const graph = state.graph;
  const scene = state.scene;
  const sel = state.selected;
  if (!graph || !sel) return { lit, onPath };

  if (sel.kind === "edge") {
    // The edge itself traces; its two ends light, and nothing else does.
    lit.add(sel.fromKey);
    lit.add(sel.toKey);
    for (const k of [...ancestorKeys(graph, keyPath(sel.fromKey)), ...ancestorKeys(graph, keyPath(sel.toKey))])
      if (!lit.has(k)) onPath.add(k);
    return {
      lit,
      onPath,
      arc: { fromKey: sel.fromKey, fromPort: sel.fromPort, toKey: sel.toKey, toPort: sel.toPort },
    };
  }
  if (sel.kind === "node") {
    lit.add(sel.key);
    for (const k of ancestorKeys(graph, keyPath(sel.key))) onPath.add(k);
    return { lit, onPath, subtree: sel.key };
  }
  if (sel.kind === "object") {
    // One activity picked within it (D62): the graph shows that activity
    // alone, as every other view's selection does (D63).
    if (sel.index !== undefined) return activityHighlight(graph, scene, sel.index);
    // The steps it passes through light, and the chain of connections that
    // carries it — at every depth, so opening a composite keeps the chain.
    const trace = selectedTrace();
    const edges = new Set<string>();
    if (!trace || !scene) return { lit, onPath, edges };
    for (const i of trace.activities) {
      const a = scene.activities[i]!;
      if (a.kind !== "processing") continue;
      const key = visibleFor(graph, a.node, state.expanded, a.process);
      if (key !== undefined) lit.add(key);
      for (const k of ancestorKeys(graph, a.node, a.process)) onPath.add(k);
    }
    for (const key of trace.arcs) {
      const a = scene.activities[scene.byArc.get(key)![0]!]!;
      if (a.kind !== "transport" && a.kind !== "relay") continue;
      for (const e of moveRoute(scene, graph, a.arc) ?? []) edges.add(edgeKey(e));
    }
    for (const k of lit) onPath.delete(k);
    return { lit, onPath, edges };
  }
  return activityHighlight(graph, scene, sel.index);
}

/**
 * What one activity lights in the graph: the box it runs in, or — for a move —
 * the connections its arc runs along. Used by a plain activity selection and
 * by an activity picked within an Object (D63), which lights the same.
 */
function activityHighlight(graph: GraphNode, scene: Scene | undefined, index: number): Highlight {
  const lit = new Set<string>();
  const onPath = new Set<string>();
  const activity = scene?.activities[index];
  if (activity) {
    // Each path with what runs there, which picks a branch's atomic arm.
    const paths: [NodePath, string | undefined][] =
      activity.kind === "processing"
        ? [[activity.node, activity.process]]
        : activity.kind === "transport" || activity.kind === "relay"
          ? [activity.arc.from.node, activity.arc.to.node].map((p) => [p, scene ? processAt(scene, p) : undefined])
          : activity.kind === "replenishment"
            ? []
            : [[activity.node, undefined]];
    for (const [path, process] of paths) {
      if (path.length === 0) continue;
      const key = visibleFor(graph, path, state.expanded, process);
      if (key !== undefined) lit.add(key);
      for (const k of ancestorKeys(graph, path, process)) onPath.add(k);
    }

    // A move serves one arc. Trace the connections it runs along, so they
    // light rather than everything that happens to touch either end. With a
    // composite open that is several — into its border, then down to the
    // step inside (D61); comparing only the two visible ends found none.
    if (activity.kind === "transport" || activity.kind === "relay") {
      const route = scene ? moveRoute(scene, graph, activity.arc) : undefined;
      if (route) {
        for (const k of lit) onPath.delete(k);
        return { lit, onPath, edges: new Set(route.map(edgeKey)) };
      }
      // Not this workflow's arc: fall back to the two ends as drawn.
      const fromKey = visibleFor(graph, activity.arc.from.node, state.expanded, scene && processAt(scene, activity.arc.from.node));
      const toKey = visibleFor(graph, activity.arc.to.node, state.expanded, scene && processAt(scene, activity.arc.to.node));
      if (fromKey !== undefined && toKey !== undefined) {
        for (const k of lit) onPath.delete(k);
        return {
          lit,
          onPath,
          arc: {
            fromKey,
            fromPort: activity.arc.from.port,
            toKey,
            toPort: activity.arc.to.port,
          },
        };
      }
    }
  }
  for (const k of lit) onPath.delete(k);
  return { lit, onPath };
}

const keyPath = (key: string): string[] => (key === "" ? [] : key.split("."));

/**
 * The moves that carry an Object along one drawn edge — the reverse of what a
 * selected move traces in the graph: a move belongs to the edge when the edge
 * is on its arc's route (`arcRoute`). That holds at any depth, open or shut;
 * matching the arc's two visible ends did not, once a composite was open and
 * the edge ran from its border to a step inside (D61). Pure Data moves nothing.
 */
function movesOn(edge: EdgeRef): number[] {
  const scene = state.scene;
  const graph = state.graph;
  if (!scene || !graph || !edge.object) return [];
  const key = edgeKey(edge);
  const on = new Map<string, boolean>();
  const out: number[] = [];
  scene.activities.forEach((a, i) => {
    if (a.kind !== "transport" && a.kind !== "relay") return;
    const arc = arcKey(a.arc);
    if (!on.has(arc)) on.set(arc, (moveRoute(scene, graph, a.arc) ?? []).some((e) => edgeKey(e) === key));
    if (on.get(arc)) out.push(i);
  });
  return out;
}

/* ── boot ──────────────────────────────────────────────────────────────── */

export async function start(): Promise<void> {
  buildViewButtons();
  buildLayoutButtons();
  wireControls();
  wireDropTarget();
  wirePointer();

  // A single-file viewer carries its documents with it and has no datasets
  // beside it to fetch (design.md D48).
  const embedded = document.getElementById("ofp-documents");
  if (embedded) {
    startEmbedded(embedded.textContent ?? "null");
    return;
  }

  try {
    const res = await fetch(new URL("datasets/index.json", document.baseURI));
    state.index = res.ok ? ((await res.json()) as DatasetIndexEntry[]) : [];
  } catch {
    state.index = [];
  }

  const picker = el<HTMLSelectElement>("dataset");
  picker.innerHTML = state.index
    .map((d) => `<option value="${d.id}">${escapeHtml(d.label)} · ${d.activities}</option>`)
    .join("");

  const shared = await decodeShare(location.hash);
  if (shared) {
    adopt(
      {
        plan: shared.plan,
        workflow: shared.workflow ?? null,
        environment: shared.environment ?? null,
      },
      "shared link",
      "Opened from a shared link.",
    );
    if (shared.ui?.view) state.view = shared.ui.view as GanttView;
    if (isLayout(shared.ui?.layout)) state.layout = shared.ui.layout;
    if (isDetails(shared.ui?.details)) state.details = shared.ui.details;
    if (shared.ui?.expanded) state.expanded = new Set(shared.ui.expanded);
    buildViewButtons();
    markExternal("shared link");
    renderAll();
    requestAnimationFrame(() => fitGraph());
    return;
  }

  const params = new URLSearchParams(location.search);
  const asked = params.get("layout");
  if (isLayout(asked)) state.layout = asked;
  const wanted = params.get("doc");
  const first = state.index.find((d) => d.id === wanted) ?? state.index[state.index.length - 1];
  if (first) {
    picker.value = first.id;
    await loadDataset(first.id);
    fitGraph();
  } else {
    showBanner(
      "No bundled plans were found.",
      ["Run <code>npm run datasets</code>, or drop a plan YAML onto this window."],
    );
  }
}

interface EmbeddedDocuments {
  readonly name?: string;
  readonly plan?: string;
  readonly workflow?: string;
  readonly environment?: string;
  /** What to open on, when the writer said (`ofp-export view --layout / --gantt / --details`). */
  readonly ui?: { readonly layout?: string; readonly view?: string; readonly details?: string };
}

/**
 * Open the documents a single-file viewer was written with.
 *
 * They are YAML text, as written, and go through the same readers as a
 * dropped file. The link button is hidden (D48, the person's decision): a
 * link made from a file on someone's disk points at that disk.
 */
function startEmbedded(json: string): void {
  el("share").hidden = true;

  let docs: EmbeddedDocuments | null;
  let raw: { plan: unknown; workflow: unknown; environment: unknown };
  try {
    docs = JSON.parse(json) as EmbeddedDocuments | null;
    raw = {
      plan: docs?.plan ? parseYaml(docs.plan) : null,
      workflow: docs?.workflow ? parseYaml(docs.workflow) : null,
      environment: docs?.environment ? parseYaml(docs.environment) : null,
    };
  } catch (e) {
    markExternal("(unreadable)");
    showBanner("The documents in this file could not be read.", [escapeHtml(String(e))]);
    return;
  }

  if (!docs || (!raw.plan && !raw.workflow)) {
    markExternal("(no documents)");
    renderAll();
    showBanner("This viewer file has no documents in it.", [
      "Drop a plan, a workflow or an environment YAML onto this window to read it.",
    ]);
    return;
  }

  const name = docs.name || "embedded documents";
  try {
    adopt(raw, name, "Embedded in this file.");
    // Unknown values are ignored rather than refused: a newer writer may know more.
    if (isLayout(docs.ui?.layout)) state.layout = docs.ui.layout;
    if (isDetails(docs.ui?.details)) state.details = docs.ui.details;
    const view = GANTT_VIEWS.find((v) => v.id === docs.ui?.view);
    if (view) {
      state.view = view.id;
      buildViewButtons();
    }
  } catch (e) {
    markExternal(name);
    showBanner("The documents in this file could not be read.", [
      escapeHtml(e instanceof ReadError ? e.message : String(e)),
    ]);
    return;
  }
  markExternal(name);
  renderAll();
  requestAnimationFrame(() => fitGraph());
}

async function loadDataset(id: string): Promise<void> {
  const res = await fetch(new URL(`datasets/${id}.json`, document.baseURI));
  if (!res.ok) {
    showBanner(`Could not load the plan "${id}".`, [`The server answered ${res.status}.`]);
    return;
  }
  const payload = (await res.json()) as DatasetPayload;

  const url = new URL(location.href);
  url.searchParams.set("doc", id);
  history.replaceState(null, "", url);
  nameTab(payload.label);

  adopt(
    payload,
    [payload.source.plan, payload.source.workflow, payload.source.environment]
      .filter(Boolean)
      .join("  ·  "),
    payload.blurb,
  );
  renderAll();
}

/** Take a set of raw documents as the thing on screen. */
function adopt(
  raw: { plan: unknown; workflow: unknown; environment: unknown },
  source: string,
  blurb: string,
): void {
  // A workflow stands on its own — it can be read before anything has been
  // scheduled from it, and that is when the feature gate is most useful. Only
  // the plan pane needs a plan.
  const { doc, refused } = readPlan(raw.plan);
  const env = raw.environment ? readEnvironment(raw.environment) : undefined;
  const workflow = raw.workflow ? readWorkflow(raw.workflow) : undefined;

  state.gate = raw.workflow ? gateWorkflow(raw.workflow) : undefined;
  state.refused = refused;
  state.blurb = blurb;
  state.source = source;
  state.selected = undefined;
  state.zoom = 1;
  state.graphZoom = 1;
  state.expanded = new Set();
  state.scene = doc ? buildScene(doc, env, workflow) : undefined;
  state.graph = workflow ? buildGraph(workflow) : undefined;
  state.raw = raw;
}

/**
 * A plan the viewer refuses is still a plan: it is answered with the reason,
 * not with "this is not a plan", and not with a crash.
 */
function readPlan(raw: unknown): { doc?: ExecutionDocument; refused?: readonly Finding[] } {
  if (!raw) return {};
  try {
    return { doc: readExecutionDocument(raw) };
  } catch (e) {
    if (e instanceof UnsupportedError) return { refused: e.findings };
    throw e;
  }
}

/* ── rendering ─────────────────────────────────────────────────────────── */

function renderAll(): void {
  const scene = state.scene;
  const graph = state.graph;
  const sel = state.selected;

  el("ro-outcome").textContent = scene?.doc.outcome ?? "—";
  el("ro-makespan").textContent = scene ? formatDuration(scene.metrics.makespan, scene.unit) : "—";
  el("ro-count").textContent = scene ? String(scene.activities.length) : "—";
  el("status-source").textContent = state.source;

  const trace = selectedTrace();
  const focus = sel?.kind === "object" ? sel.index : undefined;
  el("status-selection").textContent =
    trace && scene && focus !== undefined
      ? `${statusLine(scene, focus)} · in ${trace.label} (Esc: the whole Object)`
      : trace
      ? `Selected Object · ${trace.label}`
      : sel?.kind === "edge"
      ? `Selected connection · ${edgeLabel(sel)}`
      : sel?.kind === "node"
      ? `Selected node · ${sel.key || graph?.process || "entry"}`
      : scene
        ? statusLine(scene, sel?.kind === "activity" ? sel.index : undefined)
        : "Nothing selected — click a box";

  el("inspector").innerHTML =
    trace && scene && focus !== undefined
      ? renderInspector(scene, focus, state.blurb, trace)
      : trace && scene
      ? renderObjectDetail(scene, trace)
      : sel?.kind === "edge"
      ? renderEdgeDetail(edgeLabel(sel), carriesLabel(sel), sel.object, scene, movesOn(sel))
      : sel?.kind === "node" && graph
      ? renderNodeDetail(graph, sel.key, scene)
      : scene
        ? renderInspector(scene, sel?.kind === "activity" ? sel.index : undefined, state.blurb)
        : graph
          ? renderWorkflowOverview(graph, state.blurb)
          : "";

  renderLayout();
  renderBanner();
  renderGraphPane();
  renderChart();
}

/** What the loaded documents give each pane to show. */
function available(): { workflow: boolean; plan: boolean } {
  return { workflow: !!state.graph, plan: !!state.scene || !!state.refused };
}

/**
 * The layout in effect: the person's choice if the pane it keeps has
 * something in it, otherwise whatever was loaded asks for — a workflow alone
 * opens on the workflow alone, a plan alone on the plan alone.
 */
function currentLayout(): Layout {
  const has = available();
  const chosen = state.layout;
  if (chosen === "split" || (chosen && has[chosen])) return chosen;
  if (has.workflow && !has.plan) return "workflow";
  if (has.plan && !has.workflow) return "plan";
  return "split";
}

/** Below this width the details pane folds away unless the person keeps it (styles.css). */
const NARROW = window.matchMedia("(max-width: 1040px)");

const isDetails = (v: unknown): v is "show" | "hide" => v === "show" || v === "hide";

/** Whether the details pane is on screen: as set, or as the width allows. */
const detailsShown = (): boolean => (state.details ? state.details === "show" : !NARROW.matches);

function renderLayout(): void {
  const layout = currentLayout();
  const has = available();
  el("app").dataset["details"] = state.details ?? "auto";
  el("details").setAttribute("aria-pressed", String(detailsShown()));
  el("stack").dataset["layout"] = layout;
  el("graph-pane").hidden = layout === "plan";
  el("plan-pane").hidden = layout === "workflow";
  el("splitter").hidden = layout !== "split";
  for (const b of el("layouts").querySelectorAll<HTMLButtonElement>("[data-layout]")) {
    const id = b.dataset["layout"] as Layout;
    b.setAttribute("aria-pressed", String(id === layout));
    // A pane on its own with nothing in it is not a layout worth offering.
    b.disabled = id !== "split" && !has[id];
  }
}

function renderGraphPane(): void {
  const graph = state.graph;
  const host = el<SVGSVGElement & HTMLElement>("graph");
  const hint = el("graph-hint");

  if (!graph) {
    host.removeAttribute("width");
    host.removeAttribute("height");
    host.innerHTML = "";
    hint.textContent = "No workflow was loaded with this plan.";
    return;
  }

  const { lit, onPath, arc, subtree, edges } = litNodes();
  const g = renderGraph(graph, {
    expanded: state.expanded,
    lit,
    onPath,
    ...(arc ? { arc } : {}),
    ...(subtree !== undefined ? { subtree } : {}),
    ...(edges ? { edges } : {}),
    ...(state.scene ? { notes: annotate(state.scene, graph) } : {}),
  });
  host.setAttribute("viewBox", g.viewBox);
  host.setAttribute("width", String(Math.round(g.width * state.graphZoom)));
  host.setAttribute("height", String(Math.round(g.height * state.graphZoom)));
  host.innerHTML = g.svg;

  hint.textContent =
    `${graph.process} · ${graph.atomicCount} atomic steps · ` +
    (state.scene ? "click a box to link it to the plan" : "click a box for what it is");
}

function fitGraph(attempt = 0): void {
  const graph = state.graph;
  // A hidden pane measures zero; fitting to that would shrink the graph to the
  // floor. Switching the pane back on fits it then.
  if (!graph || el("graph-pane").hidden) return;
  const box = el("graph-scroll");

  // Fitting against a box the browser has not laid out yet produces a postage
  // stamp. Wait a frame — but not forever, since the pane really can be this
  // small once the divider is dragged up.
  if ((box.clientWidth < 120 || box.clientHeight < 80) && attempt < 12) {
    requestAnimationFrame(() => fitGraph(attempt + 1));
    return;
  }

  const g = renderGraph(graph, { expanded: state.expanded, lit: new Set(), onPath: new Set() });
  const scale = Math.min((box.clientWidth - 36) / g.width, (box.clientHeight - 36) / g.height);
  state.graphZoom = Math.max(0.3, Math.min(1.5, scale));
  renderGraphPane();
}

/** Only the marks this plan actually uses — a legend for things that are not
 *  on screen is noise, and it hides the one that is. */
function renderLegend(): void {
  const scene = state.scene;
  if (!scene) {
    el("legend").innerHTML = "";
    return;
  }
  const counts = scene.metrics.counts;
  // The Object view draws no held devices and the only view with waits (§23).
  const objects = state.view === "object";
  const held = !objects && scene.activities.some((a) => a.kind === "transport" && a.transporter);
  const resting = scene.activities.some((a) => a.kind === "processing" && !accessesDevices(a, scene.env));
  const items: [boolean, string, string][] = [
    [counts.processing > 0, "processing", "processing"],
    [resting, "resting", "resting (device free)"],
    [counts.transport > 0, "transport", "transport"],
    [held, "held", "device held"],
    [counts.relay > 0, "relay", "relay"],
    [objects, "waiting", "waiting on a spot"],
    [!objects && counts.replenishment > 0, "replenishment", "refill"],
    [!objects && counts.decision > 0, "decision", "decision"],
    [counts.gate > 0, "gate", "gate"],
    [!objects && counts.reservation > 0, "reserved", "spot kept"],
    [!objects && scene.assumed.size > 0, "assumed", "assumed (may not happen)"],
  ];
  el("legend").innerHTML = items
    .filter(([on]) => on)
    .map(([, cls, label]) => `<span class="lg"><i class="sw ${cls}"></i>${label}</span>`)
    .join("");
}

function renderChart(): void {
  const scene = state.scene;
  el("plan-empty").hidden = !!scene;
  el("chart").hidden = !scene;
  el("plan-empty-title").textContent = state.refused ? "Plan not drawn." : "No plan loaded.";
  el("plan-empty-why").innerHTML = state.refused
    ? "A plan was given, but it is one this viewer does not draw — the banner above says why."
    : "This workflow has not been scheduled yet. Run <code>ofp-schedule schedule</code> on it and " +
      "drop the plan here to see when each step runs.";
  for (const id of ["labels", "zoom-in", "zoom-out", "zoom-fit", "export"])
    el<HTMLButtonElement>(id).disabled = !scene;
  for (const b of el("views").querySelectorAll("button")) (b as HTMLButtonElement).disabled = !scene;
  if (!scene) {
    renderLegend();
    return;
  }
  offerObjectView(scene);

  // Measured from the pane, never from the scrolling row: the row is sized by
  // what is inside it, so measuring there feeds each zoom back into the next
  // one. The gutter sits inside that width, so the plot gets what is left.
  const base = Math.max(360, el("chart").clientWidth - GUTTER_W - 18);
  const lit = litActivities();

  const g = renderGantt(scene, {
    view: state.view,
    baseWidth: base,
    zoom: state.zoom,
    lit,
    ...(state.selected?.kind === "object" ? { litObject: state.selected.id } : {}),
    ...(state.selected?.kind === "object" && state.selected.index !== undefined ? { focus: state.selected.index } : {}),
    showLabels: state.labels,
    availableHeight: el("body-row").clientHeight,
  });
  state.geometry = g;

  const gutter = el<SVGSVGElement & HTMLElement>("gutter");
  gutter.setAttribute("width", String(GUTTER_W));
  gutter.setAttribute("height", String(g.height));
  gutter.innerHTML = g.gutter;

  const axis = el<SVGSVGElement & HTMLElement>("axis");
  axis.setAttribute("width", String(g.width));
  axis.setAttribute("height", "27");
  axis.innerHTML = g.axis;

  const plot = el<SVGSVGElement & HTMLElement>("plot");
  plot.setAttribute("width", String(g.width));
  plot.setAttribute("height", String(g.height));
  plot.innerHTML = g.plot;
  // After the view is settled: the legend names what this view draws.
  renderLegend();
}

const findingLine = (f: Finding): string =>
  `${escapeHtml(f.what)} at <code>${escapeHtml(f.at)}</code> — ${escapeHtml(f.why)}`;

function renderBanner(): void {
  const gate = state.gate;
  const workflowGated = !!gate && !gate.supported;
  if (state.refused) {
    // Every mark of a joint plan has the same reason, so it is said once, in
    // the headline, and the list only says where each mark was found.
    showBanner(`This plan was not drawn: ${state.refused[0]!.why}.`, [
      ...state.refused.map((f) => `${escapeHtml(f.what)} at <code>${escapeHtml(f.at)}</code>`),
      ...(workflowGated ? gate.findings.map(findingLine) : []),
    ]);
    return;
  }
  if (!workflowGated) {
    hideBanner();
    return;
  }
  showBanner(gateSummary(gate), gate.findings.map(findingLine));
}

function showBanner(headline: string, details: readonly string[]): void {
  const banner = el("banner");
  banner.innerHTML =
    `<div><b>${escapeHtml(headline)}</b>` +
    (details.length ? `<ul>${details.map((d) => `<li>${d}</li>`).join("")}</ul>` : "") +
    `</div>`;
  banner.hidden = false;
}

const hideBanner = (): void => {
  el("banner").hidden = true;
};

const DROPPED = "__external__";

/**
 * The tab says what is open, then what the page is — several single-file
 * viewers opened side by side are told apart by their tabs. A placeholder
 * (`(no documents)`) names nothing, so it leaves the name alone.
 */
function nameTab(what: string | undefined): void {
  document.title = what && !what.startsWith("(") ? `${what} — OFP View` : "OFP View";
}

/**
 * What is on screen did not come from the list, so the list must stop claiming
 * it did — and the `?doc=` in the address bar must stop pointing at a plan
 * nobody is looking at.
 */
function markExternal(label: string): void {
  const picker = el<HTMLSelectElement>("dataset");
  let option = picker.querySelector<HTMLOptionElement>(`option[value="${DROPPED}"]`);
  if (!option) {
    option = document.createElement("option");
    option.value = DROPPED;
    picker.prepend(option);
  }
  option.textContent = label;
  picker.value = DROPPED;
  nameTab(label);

  const url = new URL(location.href);
  url.searchParams.delete("doc");
  history.replaceState(null, "", url);
}

/* ── controls ──────────────────────────────────────────────────────────── */

function buildLayoutButtons(): void {
  el("layouts").innerHTML = LAYOUTS.map(
    (l) => `<button data-layout="${l.id}" title="${escapeHtml(l.hint)}" aria-pressed="false">${l.label}</button>`,
  ).join("");
}

/** A chosen layout is part of the address, so a link can open on it. */
function rememberLayout(layout: Layout | undefined): void {
  state.layout = layout;
  const url = new URL(location.href);
  if (layout) url.searchParams.set("layout", layout);
  else url.searchParams.delete("layout");
  history.replaceState(null, "", url);
}

/**
 * The Object view only where the Objects can be told apart (design.md D59).
 * Marked unavailable rather than `disabled`, so the reason stays readable in
 * its tooltip. A view asked for that cannot be drawn — by a share link, by
 * `--gantt object`, or left over from the previous plan — falls back to Device.
 */
function offerObjectView(scene: Scene): void {
  const tracing = tracingOf(scene);
  const button = el("views").querySelector<HTMLButtonElement>('[data-view="object"]');
  if (button) {
    const hint = GANTT_VIEWS.find((v) => v.id === "object")!.hint;
    if (tracing.ok) {
      button.removeAttribute("aria-disabled");
      button.title = hint;
    } else {
      button.setAttribute("aria-disabled", "true");
      button.title = ["Not available: the Objects of this plan cannot be told apart.", ...tracing.reasons].join("\n");
    }
  }
  if (state.view === "object" && !tracing.ok) {
    state.view = "device";
    for (const b of el("views").querySelectorAll("[data-view]"))
      b.setAttribute("aria-pressed", String((b as HTMLElement).dataset["view"] === state.view));
  }
}

function buildViewButtons(): void {
  el("views").innerHTML = GANTT_VIEWS.map(
    (v) =>
      `<button data-view="${v.id}" title="${escapeHtml(v.hint)}" aria-pressed="${v.id === state.view}">${v.label}</button>`,
  ).join("");
}

function wireControls(): void {
  el("views").addEventListener("click", (e) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>("[data-view]");
    if (!button || button.getAttribute("aria-disabled") === "true") return;
    state.view = button.dataset["view"] as GanttView;
    for (const b of el("views").querySelectorAll("[data-view]"))
      b.setAttribute("aria-pressed", String(b === button));
    renderChart();
  });

  el("layouts").addEventListener("click", (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-layout]");
    if (!button || button.disabled) return;
    rememberLayout(button.dataset["layout"] as Layout);
    renderAll();
    fitGraph();
  });

  // Flips what is on screen, whatever set it: a pane the width folded away
  // comes back, and one it kept goes.
  el("details").addEventListener("click", () => {
    state.details = detailsShown() ? "hide" : "show";
    renderLayout();
    renderChart();
    renderGraphPane();
  });
  // Crossing the width changes what "as the width allows" means.
  NARROW.addEventListener("change", () => renderLayout());

  el<HTMLSelectElement>("dataset").addEventListener("change", (e) => {
    const id = (e.target as HTMLSelectElement).value;
    if (id === DROPPED) return;
    // Another document set decides its own layout again.
    rememberLayout(undefined);
    void loadDataset(id).then(() => fitGraph());
  });

  el<HTMLSelectElement>("theme").addEventListener("change", (e) => {
    const value = (e.target as HTMLSelectElement).value;
    if (value === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", value);
  });

  el("labels").addEventListener("click", (e) => {
    state.labels = !state.labels;
    (e.currentTarget as HTMLElement).setAttribute("aria-pressed", String(state.labels));
    renderChart();
  });

  el("zoom-in").addEventListener("click", () => {
    state.zoom = Math.min(16, state.zoom * 1.4);
    renderChart();
  });
  el("zoom-out").addEventListener("click", () => {
    state.zoom = Math.max(1, state.zoom / 1.4);
    renderChart();
  });
  el("zoom-fit").addEventListener("click", () => {
    state.zoom = 1;
    renderChart();
  });

  el("export").addEventListener("click", () => {
    const scene = state.scene;
    const g = state.geometry;
    if (!scene || !g) return;
    const name = new URLSearchParams(location.search).get("doc") ?? "plan";
    const svg = ganttToSvg(g, `${name} — ${state.view}`, document.documentElement);
    downloadSvg(svg, `${name}.${state.view}.svg`);
  });

  // The axis follows the one scroll container horizontally.
  el("body-row").addEventListener("scroll", () => {
    el("axis-scroll").scrollLeft = el("body-row").scrollLeft;
  });

  el("expand-all").addEventListener("click", () => {
    if (!state.graph) return;
    state.expanded = new Set(compositeKeys(state.graph));
    // Deliberately not fitted: twenty-two steps in a row shrink to a smear.
    // Full size and scrollable beats visible and unreadable.
    state.graphZoom = 1;
    renderAll();
    el("graph-scroll").scrollTo({ top: 0, left: 0 });
  });
  el("collapse-all").addEventListener("click", () => {
    state.expanded = new Set();
    renderAll();
    fitGraph();
  });
  el("graph-in").addEventListener("click", () => {
    state.graphZoom = Math.min(2.4, state.graphZoom * 1.25);
    renderGraphPane();
  });
  el("graph-out").addEventListener("click", () => {
    state.graphZoom = Math.max(0.25, state.graphZoom / 1.25);
    renderGraphPane();
  });
  el("graph-fit").addEventListener("click", () => fitGraph());
  el("share").addEventListener("click", () => {
    const raw = state.raw;
    if (!raw || (!raw.plan && !raw.workflow)) return;
    void copyShareLink(
      {
        ...(raw.plan ? { plan: raw.plan } : {}),
        ...(raw.workflow ? { workflow: raw.workflow } : {}),
        ...(raw.environment ? { environment: raw.environment } : {}),
        ui: {
          view: state.view,
          expanded: [...state.expanded],
          ...(state.layout ? { layout: state.layout } : {}),
          ...(state.details ? { details: state.details } : {}),
        },
      },
      flash,
      (headline, detail) => showBanner(headline, [escapeHtml(detail)]),
    );
  });

  wireGraphPointer({
    graph: () => state.graph,
    expanded: () => state.expanded,
    onToggle: (key) => {
      if (state.expanded.has(key)) state.expanded.delete(key);
      else state.expanded.add(key);
      renderAll();
    },
    onSelect: (key) => select(key === undefined ? undefined : { kind: "node", key }),
    onSelectEdge: (edge) => select({ kind: "edge", ...edge }),
  });
  wireSplitter(
    () => state.split,
    (pct) => {
      state.split = pct;
    },
    renderChart,
  );

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // Out one level: from an activity within an Object to the Object, then to nothing.
    const sel = state.selected;
    if (sel?.kind === "object" && sel.index !== undefined) select({ kind: "object", id: sel.id });
    else select(undefined);
  });

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      renderChart();
      renderGraphPane();
    }, 120);
  });
}

function same(a: Selection | undefined, b: Selection | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === "activity") return a.index === (b as typeof a).index;
  if (a.kind === "object") return a.id === (b as typeof a).id && a.index === (b as typeof a).index;
  if (a.kind === "node") return a.key === (b as typeof a).key;
  return edgeLabel(a) === edgeLabel(b as typeof a);
}

/** Picking the same thing twice puts it down. */
function select(next: Selection | undefined): void {
  state.selected = same(state.selected, next) ? undefined : next;
  renderAll();
}

/* ── pointer ───────────────────────────────────────────────────────────── */

function wirePointer(): void {
  const plot = el("plot");
  const tip = el("tip");

  plot.addEventListener("click", (e) => {
    // In the Object view the lane is the unit: a step two Objects share sits
    // on both lanes, and the lane clicked says which Object was meant (D58-2).
    const object = state.view === "object" ? (e.target as HTMLElement).closest<HTMLElement>("[data-o]") : null;
    if (object) {
      // Two steps (D62): a bar of a lane not yet picked picks its Object; a
      // bar of the picked lane picks that activity within it. The same bar
      // again steps back out to the Object. A wait is no activity.
      const id = object.dataset["o"]!;
      const i = object.dataset["i"];
      const sel = state.selected;
      const inPicked = sel?.kind === "object" && sel.id === id;
      if (!inPicked || i === undefined) select({ kind: "object", id });
      else if (sel.index === Number(i)) select({ kind: "object", id });
      else select({ kind: "object", id, index: Number(i) });
      return;
    }
    const hit = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    select(hit ? { kind: "activity", index: Number(hit.dataset["i"]) } : undefined);
  });

  el("gutter").addEventListener("click", (e) => {
    const lane = (e.target as HTMLElement).closest<HTMLElement>("[data-o]");
    // The label always means the whole Object: from one of its activities it
    // steps back out, and on the Object itself it puts it down (`select`).
    if (lane) select({ kind: "object", id: lane.dataset["o"]! });
  });

  plot.addEventListener("mousemove", (e) => {
    const scene = state.scene;
    const hit = (e.target as HTMLElement).closest<HTMLElement>("[data-i], [data-wait]");
    if (!scene || !hit) {
      tip.style.display = "none";
      return;
    }
    const wait = hit.dataset["wait"];
    if (wait !== undefined) {
      const [start, end] = wait.split(" ").map(Number) as [number, number];
      tip.innerHTML = waitTooltip(scene, hit.dataset["o"] ?? "", start, end);
    } else tip.innerHTML = tooltipFor(scene, Number(hit.dataset["i"]));
    placeTip(tip, e);
  });

  plot.addEventListener("mouseleave", () => {
    tip.style.display = "none";
  });
}

/* ── dropped files ─────────────────────────────────────────────────────── */

/**
 * Files are sorted by what they turn out to be, not by their name: the reader
 * that accepts a file decides.
 *
 * A drop replaces the whole set rather than merging into what is loaded. The
 * alternative is worse than it sounds — dropping one workflow onto another
 * plan pairs two documents that have nothing to do with each other, and the
 * viewer would draw the mismatch without a word. To see a plan against its
 * workflow, drop both; the banner says what each file was taken as.
 */
function wireDropTarget(): void {
  const overlay = el("drop");
  let depth = 0;

  addEventListener("dragenter", (e) => {
    e.preventDefault();
    depth += 1;
    overlay.classList.add("on");
  });
  addEventListener("dragover", (e) => e.preventDefault());
  addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.classList.remove("on");
  });
  addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    overlay.classList.remove("on");
    void acceptFiles([...(e.dataTransfer?.files ?? [])]);
  });
}

async function acceptFiles(files: readonly File[]): Promise<void> {
  if (!files.length) return;

  let doc: ExecutionDocument | undefined;
  let env: Environment | undefined;
  let workflow: Workflow | undefined;
  let gate: GateReport | undefined;
  let refused: readonly Finding[] | undefined;
  let rawPlan: unknown = null;
  let rawWorkflow: unknown = null;
  let rawEnvironment: unknown = null;
  const accepted: string[] = [];
  const rejected: string[] = [];

  for (const file of files) {
    const text = await file.text();
    try {
      doc = readExecutionDocumentText(text);
      rawPlan = parseYaml(text);
      accepted.push(`${file.name} → plan`);
      state.selected = undefined;
      continue;
    } catch (e) {
      // A plan this viewer refuses is recognised as a plan, not tried as the next shape.
      if (e instanceof UnsupportedError) {
        refused = e.findings;
        doc = undefined;
        accepted.push(`${file.name} → plan (not drawn)`);
        continue;
      }
    }
    try {
      workflow = readWorkflowText(text);
      rawWorkflow = parseYaml(text);
      gate = gateWorkflow(rawWorkflow);
      accepted.push(`${file.name} → workflow`);
      state.selected = undefined;
      continue;
    } catch {
      /* not a workflow */
    }
    try {
      env = readEnvironmentText(text);
      rawEnvironment = parseYaml(text);
      accepted.push(`${file.name} → environment`);
      continue;
    } catch (e) {
      rejected.push(`${file.name} — ${e instanceof ReadError ? e.message : "not a plan, a workflow or an environment"}`);
    }
  }

  if (!doc && !workflow && !refused) {
    showBanner("Nothing to draw yet.", [
      ...rejected.map(escapeHtml),
      "Drop a workflow to read it, or a plan to see when its steps run — " +
        "<code>ofp-schedule schedule … -o plan.yaml</code> writes one.",
    ]);
    return;
  }

  rememberLayout(undefined);
  state.gate = gate;
  state.refused = doc ? undefined : refused;
  state.selected = undefined;
  state.blurb = accepted.join(", ");
  state.source = files.map((f) => f.name).join("  ·  ");
  state.scene = doc ? buildScene(doc, env, workflow) : undefined;
  state.graph = workflow ? buildGraph(workflow) : undefined;
  state.expanded = new Set();
  state.raw = { plan: rawPlan, workflow: rawWorkflow, environment: rawEnvironment };
  markExternal(files.length === 1 ? files[0]!.name : `${files.length} dropped files`);
  renderAll();
  fitGraph();
  if (rejected.length) showBanner("Some files were not used.", rejected.map(escapeHtml));
}


let flashTimer: ReturnType<typeof setTimeout> | undefined;

/** A transient line in the status strip; the selection returns after it. */
function flash(message: string): void {
  const status = el("status-selection");
  const previous = status.textContent ?? "";
  status.textContent = message;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    status.textContent = previous;
  }, 4000);
}
