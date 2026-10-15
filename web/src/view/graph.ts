/**
 * Draw the workflow graph as SVG.
 *
 * Z-order is the whole trick: an open container's fill would bury the edges
 * running through it, so the shells go down first, the edges over them, and
 * the boxes people click on last.
 */

import { edgeSegments, GRAPH_METRICS, layoutGraph, type GraphLayout, type LaidEdge, type LaidNode } from "../layout/graph";
import type { BoxNote } from "../model/annotate";
import { edgeKey, type GraphNode } from "../model/graph";

const { HEADER_H, PORT_ROW, BOX_HEADER } = GRAPH_METRICS;

export interface GraphOptions {
  readonly expanded: ReadonlySet<string>;
  /** Boxes to emphasise; everything else recedes. Empty = no selection. */
  readonly lit: ReadonlySet<string>;
  /** Boxes on the way to a lit one — outlined, not filled. */
  readonly onPath: ReadonlySet<string>;
  /**
   * The one connection a selected move serves.
   *
   * A move carries exactly one Object between two ports, so exactly one edge
   * should trace. Lighting everything that touches the two boxes — which is
   * what "either end is lit" does — says the move is related to five
   * connections when it serves one.
   *
   * The ports are matched only when the box on that side really exposes them:
   * an arc into a *closed* composite names a port of the atomic step inside
   * it, which the composite's own border does not have.
   */
  readonly arc?: {
    readonly fromKey: string;
    readonly fromPort: string;
    readonly toKey: string;
    readonly toPort: string;
  };
  /** A selected box traces the dataflow *inside* it, when it is open. */
  readonly subtree?: string;
  /**
   * The connections a selected Object runs along, as `edgeKey`s — every
   * level of nesting, of which only the open ones are drawn (`arcRoute`).
   */
  readonly edges?: ReadonlySet<string>;
  /**
   * What the plan says of each structured box (`annotate`): its invocations,
   * and for an arm how many invocations took it. Absent with no plan loaded.
   */
  readonly notes?: ReadonlyMap<string, BoxNote>;
}

export interface GraphRender {
  readonly svg: string;
  /** The picture's size, margin included, and the `viewBox` that frames it. */
  readonly width: number;
  readonly height: number;
  readonly viewBox: string;
}

/**
 * Room around the outermost box. The entry composite's border sits on the
 * picture's edge, and its port dots are centred on that border: a dot reaches
 * 3.1px out (radius 2.6 plus half its outline) and a lit outline 1px, so a
 * 2px margin cut the outer half of every entry input and output off.
 */
export const GRAPH_MARGIN = 8;

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function renderGraph(root: GraphNode, opts: GraphOptions): GraphRender {
  const layout: GraphLayout = layoutGraph(root, opts.expanded);
  const active = opts.lit.size > 0;

  const classesFor = (n: LaidNode): string =>
    [
      "gnode",
      n.node.kind,
      n.node.structure === "invoke" ? "" : n.node.structure,
      armState(n.node, opts.notes),
      n.open ? "open" : "shut",
      opts.lit.has(n.key) ? "lit" : "",
      opts.onPath.has(n.key) ? "on-path" : "",
      active && !opts.lit.has(n.key) && !opts.onPath.has(n.key) ? "dim" : "",
    ]
      .filter(Boolean)
      .join(" ");

  const all = [...layout.shells, ...layout.leaves];
  const shells = layout.shells.map((n) => shell(n, classesFor(n), opts.notes)).join("");
  const leaves = layout.leaves.map((n) => leaf(n, classesFor(n), opts.notes)).join("");

  const under = (key: string, root: string): boolean =>
    root === "" || key === root || key.startsWith(`${root}.`);

  const traced = (e: (typeof layout.edges)[number]): boolean => {
    if (opts.edges) return opts.edges.has(edgeKey(e));
    if (opts.arc) {
      if (e.fromKey !== opts.arc.fromKey || e.toKey !== opts.arc.toKey) return false;
      const source = all.find((n) => n.key === e.fromKey);
      const target = all.find((n) => n.key === e.toKey);
      const portsKnown =
        source?.outputs.some((a) => a.port === opts.arc!.fromPort) === true &&
        target?.inputs.some((a) => a.port === opts.arc!.toPort) === true;
      return !portsKnown || (e.fromPort === opts.arc.fromPort && e.toPort === opts.arc.toPort);
    }
    if (opts.subtree !== undefined)
      return under(e.fromKey, opts.subtree) && under(e.toKey, opts.subtree);
    return false;
  };

  const edges = layout.edges
    .map((e) => {
      const on = traced(e);
      const cls = ["edge", e.object ? "" : "data", on ? "lit" : "", active && !on ? "dim" : ""]
        .filter(Boolean)
        .join(" ");
      const d = pathOf(e);
      const head = `<path class="arrow${on ? " lit" : ""}${active && !on ? " dim" : ""}" d="M ${r(e.to.x)} ${r(e.to.y)} l -5.5 -2.8 l 0 5.6 z"/>`;
      return `<path class="${cls}" d="${d}"/>${head}`;
    })
    .join("");

  // A 1.25px line is too thin to hit, and a miss lands on the open container
  // underneath — selecting all of it. Each edge gets a wide invisible twin
  // that carries its identity, above the drawn edges and below the boxes.
  const hits = layout.edges
    .map((e) => {
      const d = pathOf(e);
      return (
        `<path class="edge-hit" d="${d}" data-from="${esc(e.fromKey)}" data-from-port="${esc(e.fromPort)}" ` +
        `data-to="${esc(e.toKey)}" data-to-port="${esc(e.toPort)}" data-object="${e.object}"` +
        (e.fromType !== undefined ? ` data-from-type="${esc(e.fromType)}"` : "") +
        (e.toType !== undefined ? ` data-to-type="${esc(e.toType)}"` : "") +
        `/>`
      );
    })
    .join("");

  return {
    svg: shells + edges + hits + leaves,
    width: layout.width + 2 * GRAPH_MARGIN,
    height: layout.height + 2 * GRAPH_MARGIN,
    viewBox: `${-GRAPH_MARGIN} ${-GRAPH_MARGIN} ${layout.width + 2 * GRAPH_MARGIN} ${layout.height + 2 * GRAPH_MARGIN}`,
  };
}

const r = (n: number): number => Math.round(n * 10) / 10;

/** An edge's SVG path: its segments (layout), joined. The hit line uses the same. */
function pathOf(e: LaidEdge): string {
  const segs = edgeSegments(e);
  const [start] = segs[0]!;
  return (
    `M ${r(start.x)} ${r(start.y)} ` +
    segs.map(([, c1, c2, end]) => `C ${r(c1.x)} ${r(c1.y)}, ${r(c2.x)} ${r(c2.y)}, ${r(end.x)} ${r(end.y)}`).join(" ")
  );
}

/**
 * How a box names what it is, beside its id: nothing for a plain step of the
 * same name, else its process — and for a structured node its kind, with
 * what the plan says of it (`annotate`).
 */
function subtitle(node: GraphNode, notes: ReadonlyMap<string, BoxNote> | undefined): string {
  const note = notes?.get(node.key);
  const runs = note?.invocations !== undefined ? ` ×${note.invocations}` : "";
  switch (node.structure) {
    case "map":
    case "fold":
      return `${node.structure}${runs} · ${node.process}`;
    case "do_while":
      return `loop${runs}${node.limit !== undefined ? ` ≤${node.limit}` : ""} · ${node.process}`;
    case "branch":
      return node.condition ? `branch on ${node.condition}` : "branch";
    case "arm": {
      const counts = note ? [note.ran ? `×${note.ran}` : "", note.assumed ? `×${note.assumed}?` : ""].filter(Boolean).join(" ") : "";
      return `${node.process || "as it came"}${counts ? ` · ${counts}` : ""}`;
    }
    default:
      return node.process === node.id ? "" : node.process;
  }
}

/**
 * An arm the plan took (`ran`), one it only assumes (`assumed`, dashed), or
 * one no invocation took (`idle`, receding). Nothing without a plan.
 */
function armState(node: GraphNode, notes: ReadonlyMap<string, BoxNote> | undefined): string {
  const note = node.structure === "arm" ? notes?.get(node.key) : undefined;
  if (!note) return "";
  if (note.ran) return "ran";
  if (note.assumed) return "assumed";
  return "idle";
}

/** The id as shown: an arm is `then` / `else`. */
const shownId = (node: GraphNode): string => (node.structure === "arm" ? (node.arm ?? node.id) : node.id);

function shell(n: LaidNode, cls: string, notes?: ReadonlyMap<string, BoxNote>): string {
  const parts = [`<g class="${cls}" data-key="${esc(n.key)}" transform="translate(${r(n.x)},${r(n.y)})">`];
  parts.push(`<rect class="box" width="${r(n.w)}" height="${r(n.h)}"/>`);
  parts.push(`<text class="nid" x="11" y="16">${esc(shownId(n.node) || n.node.process)}</text>`);
  const sub = n.node.structure === "invoke" ? `${n.node.process} · ${n.node.atomicCount} steps` : subtitle(n.node, notes);
  parts.push(`<text class="nsub" x="${r(n.w) - 11}" y="16" text-anchor="end">${esc(sub)}</text>`);
  parts.push(`<line class="rule" x1="0" y1="${BOX_HEADER}" x2="${r(n.w)}" y2="${BOX_HEADER}"/>`);
  if (n.node.key !== "")
    parts.push(`<text class="chev" x="11" y="${r(n.h) - 8}">▾ close</text>`);
  parts.push(ports(n));
  parts.push("</g>");
  return parts.join("");
}

function leaf(n: LaidNode, cls: string, notes?: ReadonlyMap<string, BoxNote>): string {
  const parts = [`<g class="${cls}" data-key="${esc(n.key)}" transform="translate(${r(n.x)},${r(n.y)})">`];
  parts.push(`<rect class="box" width="${r(n.w)}" height="${r(n.h)}"/>`);
  parts.push(`<text class="nid" x="10" y="16">${esc(clip(shownId(n.node), 15))}</text>`);

  if (n.node.structure !== "invoke") {
    // What kind of node it is matters more than the step count: `map ×3`,
    // `loop ≤5`, `then · wash ×2`. The full text is the tooltip.
    const sub = subtitle(n.node, notes);
    parts.push(
      `<text class="nsub" x="${r(n.w) - 9}" y="16" text-anchor="end"><title>${esc(sub)}</title>${esc(clip(sub, 18))}</text>`,
    );
    if (n.node.kind === "composite") parts.push(`<text class="chev" x="10" y="${r(n.h) - 6}">▸ open</text>`);
  } else if (n.node.kind === "composite") {
    // The badge is the affordance and the count at once (D11). It sits inside
    // the header with room to spare — at fourteen pixels it landed on the rule.
    const w = 38;
    parts.push(`<rect class="badge" x="${r(n.w) - w - 8}" y="5" width="${w}" height="12" rx="3"/>`);
    parts.push(
      `<text class="btext" x="${r(n.w) - w / 2 - 8}" y="13.8" text-anchor="middle">▸ ×${n.node.atomicCount}</text>`,
    );
  } else if (n.node.process !== n.node.id) {
    parts.push(
      `<text class="nsub" x="${r(n.w) - 9}" y="16" text-anchor="end">${esc(clip(n.node.process, 16))}</text>`,
    );
  }

  parts.push(`<line class="rule" x1="0" y1="${HEADER_H - 3}" x2="${r(n.w)}" y2="${HEADER_H - 3}"/>`);
  parts.push(ports(n));
  parts.push("</g>");
  return parts.join("");
}

function ports(n: LaidNode): string {
  const out: string[] = [];
  const label = n.open ? 11 : 12;
  // A closed box's arcs arrive from outside, so its port names sit on the
  // port's line. An open container's arcs run *inward* from its border along
  // that same line, through the name — so there the name sits just above it.
  const dy = n.open ? -4 : 3;
  for (const a of n.inputs) {
    const y = r(a.y - n.y);
    out.push(`<circle class="pdot" cx="0" cy="${y}" r="2.6"/>`);
    out.push(`<text class="pname" x="7" y="${y + dy}">${esc(clip(a.port, label))}</text>`);
  }
  for (const a of n.outputs) {
    const y = r(a.y - n.y);
    out.push(`<circle class="pdot" cx="${r(n.w)}" cy="${y}" r="2.6"/>`);
    out.push(
      `<text class="pname" x="${r(n.w) - 7}" y="${y + dy}" text-anchor="end">${esc(clip(a.port, label))}</text>`,
    );
  }
  return out.join("");
}

export const GRAPH_ROW = PORT_ROW;
