/**
 * Lay the workflow out left to right, containers nested in place.
 *
 * A layered layout rather than a library: the graphs here are dataflow, so the
 * layer of a node is one past the deepest sibling it reads from. Ports get
 * their own anchors because an arc between two multi-port steps is ambiguous
 * otherwise (D19), and a closed composite keeps the ports of the process it
 * stands for, so an edge into it lands somewhere meaningful whether it is open
 * or shut.
 *
 * An arc that skips a column gets a lane through each column it crosses, so it
 * runs through no box it does not join; where a container has one, its columns
 * are ordered by where what feeds them arrives. A container without one is
 * laid out as layers alone (D54). One pass, left to right: nothing iterates to
 * a fixed point, so the layout always ends.
 *
 * Pure: no DOM, no colours. Positions are absolute, in one coordinate space.
 */

import type { GraphNode } from "../model/graph";

export const NODE_W = 178;
/** Tall enough that the badge and the descenders clear the rule beneath. */
const HEADER_H = 24;
const PORT_ROW = 15;
const NODE_PAD_B = 7;
const GAP_X = 58;
const GAP_Y = 18;
const BOX_PAD = 14;
const BOX_HEADER = 25;
/** Room inside a container's border for its own port labels. */
const PORT_GUTTER = 78;
/** The slot an arc takes in a column it passes through (design.md D54). */
const LANE_H = 12;

export interface Anchor {
  readonly port: string;
  readonly x: number;
  readonly y: number;
}

export interface LaidNode {
  readonly node: GraphNode;
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly open: boolean;
  readonly depth: number;
  readonly inputs: readonly Anchor[];
  readonly outputs: readonly Anchor[];
}

export interface LaidEdge {
  readonly from: { x: number; y: number };
  readonly to: { x: number; y: number };
  readonly object: boolean;
  readonly fromKey: string;
  readonly fromPort: string;
  readonly toKey: string;
  readonly toPort: string;
  /** Declared types at either end, as written. Normally the same; shown apart if not. */
  readonly fromType?: string;
  readonly toType?: string;
  /**
   * The columns this arc passes through on its way, left to right: in each it
   * runs level at `y` from `x0` to `x1`, in a slot kept clear for it. Absent
   * for an arc between neighbouring columns (design.md D54).
   */
  readonly route?: readonly Waypoint[];
}

export interface Waypoint {
  readonly x0: number;
  readonly x1: number;
  readonly y: number;
}

type Point = { readonly x: number; readonly y: number };

/**
 * The drawn path of an edge, as cubic segments `[start, control, control, end]`.
 *
 * Between columns it is the S-curve every arc has always been; through a
 * column it skips it runs level in its lane. The view draws these, the hit
 * line follows them, and the tests sample them — one shape for all three.
 */
export function edgeSegments(e: LaidEdge): [Point, Point, Point, Point][] {
  const curve = (a: Point, b: Point): [Point, Point, Point, Point] => {
    const dx = Math.max(24, (b.x - a.x) / 2);
    return [a, { x: a.x + dx, y: a.y }, { x: b.x - dx, y: b.y }, b];
  };
  const same = (a: Point, b: Point): boolean => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
  const out: [Point, Point, Point, Point][] = [];
  let at: Point = e.from;
  for (const w of e.route ?? []) {
    const enter = { x: w.x0, y: w.y };
    const leave = { x: w.x1, y: w.y };
    // A run beside a narrow box begins at its port: nothing to bend first (D66).
    if (!same(at, enter)) out.push(curve(at, enter));
    out.push([enter, enter, leave, leave]);
    at = leave;
  }
  if (!same(at, e.to)) out.push(curve(at, e.to));
  return out;
}

export interface GraphLayout {
  readonly width: number;
  readonly height: number;
  /** Open containers, outermost first — drawn under the edges. */
  readonly shells: readonly LaidNode[];
  /** Closed boxes and atomic steps — drawn over the edges. */
  readonly leaves: readonly LaidNode[];
  readonly edges: readonly LaidEdge[];
}

interface Sized {
  readonly node: GraphNode;
  readonly open: boolean;
  readonly w: number;
  readonly h: number;
  /**
   * Relative to this node's own origin, with the column each child stands in:
   * a box narrower than its column is centred in it, and an arc to or from it
   * runs level across the slack (`leadIn` / `leadOut`).
   */
  readonly placed: {
    readonly sized: Sized;
    readonly x: number;
    readonly y: number;
    readonly col: { readonly x: number; readonly w: number };
  }[];
  /** Lanes through skipped columns, by connection id (`laneId`), relative to this origin. */
  readonly lanes: Readonly<Record<string, readonly Waypoint[]>>;
}

/** A connection inside a container, named by where it lands: one binding per input port. */
const laneId = (target: string, port: string): string => `in:${target}.${port}`;
const returnId = (port: string, from: string): string => `out:${port}<${from}`;

export function layoutGraph(root: GraphNode, expanded: ReadonlySet<string>): GraphLayout {
  const sized = measure(root, expanded);

  const shells: LaidNode[] = [];
  const leaves: LaidNode[] = [];
  const edges: LaidEdge[] = [];

  const place = (s: Sized, ox: number, oy: number, depth: number): void => {
    const laid: LaidNode = {
      node: s.node,
      key: s.node.key,
      x: ox,
      y: oy,
      w: s.w,
      h: s.h,
      open: s.open,
      depth,
      inputs: inputAnchors(s).map((a) => ({ ...a, x: a.x + ox, y: a.y + oy })),
      outputs: outputAnchors(s).map((a) => ({ ...a, x: a.x + ox, y: a.y + oy })),
    };
    (s.open ? shells : leaves).push(laid);
    if (!s.open) return;

    const byId = new Map(s.placed.map((p) => [p.sized.node.id, p]));

    // An arc changes height only in the gap between two columns, where nothing
    // is drawn. Beside a box narrower than its column it runs level: out from
    // the box's right edge to the column's, and in from the column's left edge
    // to the box. Boxes in a column never overlap in height, so a level run at
    // a port's height meets no other box — without it the curve bent inside
    // the column and could cut the corner of an open neighbour (design.md D66).
    const leadOut = (src: (typeof s.placed)[number], at: Anchor): Waypoint[] => {
      const edge = ox + src.col.x + src.col.w;
      return at.x < edge - 0.5 ? [{ x0: at.x, x1: edge, y: at.y }] : [];
    };
    const leadIn = (dst: (typeof s.placed)[number], at: Anchor): Waypoint[] => {
      const edge = ox + dst.col.x;
      return at.x > edge + 0.5 ? [{ x0: edge, x1: at.x, y: at.y }] : [];
    };
    const through = (id: string): Waypoint[] =>
      (s.lanes[id] ?? []).map((w) => ({ x0: w.x0 + ox, x1: w.x1 + ox, y: w.y + oy }));
    const routeOf = (ws: Waypoint[]): { route?: Waypoint[] } => (ws.length ? { route: ws } : {});
    const anchorsOf = (p: { sized: Sized; x: number; y: number }) => ({
      inputs: inputAnchors(p.sized).map((a) => ({ ...a, x: a.x + ox + p.x, y: a.y + oy + p.y })),
      outputs: outputAnchors(p.sized).map((a) => ({ ...a, x: a.x + ox + p.x, y: a.y + oy + p.y })),
    });

    for (const p of s.placed) {
      const target = anchorsOf(p);
      for (const [port, binding] of Object.entries(p.sized.node.bindings)) {
        const to = target.inputs.find((a) => a.port === port);
        if (!to) continue;

        const dot = binding.from.indexOf(".");
        const head = dot < 0 ? binding.from : binding.from.slice(0, dot);
        const tail = dot < 0 ? "" : binding.from.slice(dot + 1);

        let from: Anchor | undefined;
        let fromKey: string;
        let source: (typeof s.placed)[number] | undefined;
        // Typed here, where it is known which side of which box the port is on:
        // a box may have an input and an output of the same name (`plate`).
        let fromType: string | undefined;
        if (head === "inputs") {
          // The container's own inbound port, on its left border.
          from = laid.inputs.find((a) => a.port === tail);
          fromKey = laid.key;
          fromType = s.node.inputTypes[tail];
        } else {
          const src = byId.get(head);
          if (!src) continue;
          from = anchorsOf(src).outputs.find((a) => a.port === tail);
          fromKey = src.sized.node.key;
          fromType = src.sized.node.outputTypes[tail];
          source = src;
        }
        if (!from) continue;
        const toType = p.sized.node.inputTypes[port];
        const route = [
          ...(source ? leadOut(source, from) : []),
          ...through(laneId(p.sized.node.id, port)),
          ...leadIn(p, to),
        ];
        edges.push({
          from: { x: from.x, y: from.y },
          to: { x: to.x, y: to.y },
          object: binding.object,
          fromKey,
          fromPort: from.port,
          toKey: p.sized.node.key,
          toPort: port,
          ...(fromType !== undefined ? { fromType } : {}),
          ...(toType !== undefined ? { toType } : {}),
          ...routeOf(route),
        });
      }
    }

    // What the container hands back out, drawn to its right border — from
    // each arm, for a branch.
    for (const [port, sources] of Object.entries(s.node.returns)) {
      for (const source of sources) {
        const dot = source.indexOf(".");
        if (dot < 0) continue;
        const src = byId.get(source.slice(0, dot));
        const to = laid.outputs.find((a) => a.port === port);
        if (!src || !to) continue;
        const from = anchorsOf(src).outputs.find((a) => a.port === source.slice(dot + 1));
        if (!from) continue;
        const fromType = src.sized.node.outputTypes[from.port];
        const toType = s.node.outputTypes[port];
        const route = [...leadOut(src, from), ...through(returnId(port, src.sized.node.id))];
        edges.push({
          from: { x: from.x, y: from.y },
          to: { x: to.x, y: to.y },
          object: s.node.returnsObject[port] ?? true,
          fromKey: src.sized.node.key,
          fromPort: from.port,
          toKey: laid.key,
          toPort: port,
          ...(fromType !== undefined ? { fromType } : {}),
          ...(toType !== undefined ? { toType } : {}),
          ...routeOf(route),
        });
      }
    }

    for (const p of s.placed) place(p.sized, ox + p.x, oy + p.y, depth + 1);
  };

  place(sized, 0, 0, 0);

  return { width: sized.w, height: sized.h, shells, leaves, edges };
}

/** Size a node and, if it is open, place its children inside it. */
function measure(node: GraphNode, expanded: ReadonlySet<string>): Sized {
  const open = node.kind === "composite" && (node.key === "" || expanded.has(node.key));

  if (!open) {
    const rows = Math.max(node.inputs.length, node.outputs.length, 1);
    return { node, open, w: NODE_W, h: HEADER_H + rows * PORT_ROW + NODE_PAD_B, placed: [], lanes: {} };
  }

  const children = node.children.map((c) => measure(c, expanded));
  const byId = new Map(children.map((c) => [c.node.id, c]));

  // Layer = one past the deepest sibling this node reads from.
  const layer = new Map<string, number>();
  const depthOf = (c: Sized, seen: Set<string>): number => {
    const known = layer.get(c.node.id);
    if (known !== undefined) return known;
    if (seen.has(c.node.id)) return 0; // a cycle is not valid v0; do not hang on one
    seen.add(c.node.id);
    let d = 0;
    for (const binding of Object.values(c.node.bindings)) {
      const dot = binding.from.indexOf(".");
      const head = dot < 0 ? binding.from : binding.from.slice(0, dot);
      const src = byId.get(head);
      if (src && src !== c) d = Math.max(d, depthOf(src, seen) + 1);
    }
    layer.set(c.node.id, d);
    return d;
  };
  for (const c of children) depthOf(c, new Set());

  // Layers of a valid (acyclic) body run 0, 1, 2… without a gap. A cycle —
  // invalid v0, but anything can be dropped on the window — can leave one, so
  // the layers are renumbered densely: an empty column would have no height.
  const dense = new Map([...new Set(layer.values())].sort((a, b) => a - b).map((d, i) => [d, i]));
  for (const [id, d] of layer) layer.set(id, dense.get(d)!);
  const columns: Sized[][] = [];
  for (const c of children) {
    const d = layer.get(c.node.id) ?? 0;
    (columns[d] ??= []).push(c);
  }

  const left = BOX_PAD + (node.inputs.length ? PORT_GUTTER : 0);
  const right = BOX_PAD + (Object.keys(node.returns).length ? PORT_GUTTER : 0);

  const links = connections(node, children, layer, columns.length);
  const long = links.filter((l) => l.toCol - l.fromCol > 1);

  // Column widths do not depend on order, and lanes add no width.
  let x = left;
  const xs: { x: number; w: number }[] = [];
  for (const column of columns) {
    const w = column?.length ? Math.max(...column.map((c) => c.w)) : 0;
    xs.push({ x, w });
    x += w + GAP_X;
  }
  const contentW = Math.max(x - GAP_X - left, 60);

  const placed: Sized["placed"] = [];
  const lanes: Record<string, Waypoint[]> = {};

  if (!long.length) {
    // Nothing skips a column: each column in document order, centred. A lane
    // is only ever added, so a workflow without one is placed as before
    // (design.md D54); its arcs still bend only between columns (D66).
    const heights = columns.map((col) => col.reduce((sum, c) => sum + c.h, 0) + GAP_Y * (col.length - 1));
    const contentH = Math.max(Math.max(0, ...heights), 44);
    columns.forEach((column, i) => {
      let y = BOX_HEADER + BOX_PAD + (contentH - heights[i]!) / 2;
      for (const c of column) {
        placed.push({ sized: c, x: xs[i]!.x + (xs[i]!.w - c.w) / 2, y, col: xs[i]! });
        y += c.h + GAP_Y;
      }
    });
    return { node, open, w: left + contentW + right, h: BOX_HEADER + BOX_PAD * 2 + contentH, placed, lanes };
  }

  // Some arc skips a column. It gets a slot in every column it crosses, and
  // each column is ordered so that its boxes and slots sit near what feeds
  // them — the barycentre of their sources' port heights (design.md D54).
  type Item = { kind: "node"; sized: Sized; h: number } | { kind: "lane"; link: Link; h: number };
  const items: Item[][] = columns.map((col) => col.map((sized) => ({ kind: "node", sized, h: sized.h })));
  for (const l of long) for (let c = l.fromCol + 1; c < l.toCol; c++) items[c]!.push({ kind: "lane", link: l, h: LANE_H });

  const stacked = (col: readonly Item[]): number => col.reduce((sum, it) => sum + it.h, 0) + GAP_Y * (col.length - 1);
  const contentH = Math.max(Math.max(0, ...items.map(stacked)), 44);

  // Heights relative to a column's centre: centring each column afterwards
  // shifts it as a whole, so what is compared here is what is drawn.
  const top = new Map<Sized, number>();
  const laneAt = new Map<string, number>();
  const inputY = (port: string): number => {
    const i = node.inputs.indexOf(port);
    return (BOX_PAD * 2 + contentH) * ((i + 1) / (node.inputs.length + 1) - 0.5);
  };
  const sourceY = (l: Link): number =>
    l.source.kind === "input"
      ? inputY(l.source.port)
      : top.get(l.source.sized)! + (outputAnchors(l.source.sized).find((a) => a.port === l.source.port)?.y ?? 0);
  const arriving = (l: Link, col: number): number =>
    l.fromCol === col - 1 ? sourceY(l) : laneAt.get(`${l.id}@${col - 1}`)!;

  items.forEach((col, c) => {
    const want = col.map((it, i) => {
      if (it.kind === "lane") return { it, i, key: arriving(it.link, c) };
      // A box wants its ports level with what feeds them, so the key is where
      // its centre would be for that, averaged over what arrives from the left.
      // Only what arrives from the left: in a cycle a link can come from a
      // column not yet ordered, and there is nothing to line up with.
      const into = links.filter((l) => l.target === it.sized && l.toCol === c && l.fromCol < c);
      if (!into.length) return { it, i, key: undefined };
      const ports = inputAnchors(it.sized);
      const centre = (l: Link) =>
        arriving(l, c) - (ports.find((a) => a.port === l.port)?.y ?? it.h / 2) + it.h / 2;
      return { it, i, key: into.reduce((sum, l) => sum + centre(l), 0) / into.length };
    });
    // What nothing feeds from the left keeps the place it would have had.
    let y = -stacked(col) / 2;
    for (const w of want) {
      w.key ??= y + w.it.h / 2;
      y += w.it.h + GAP_Y;
    }
    want.sort((a, b) => a.key! - b.key! || a.i - b.i);

    let at = -stacked(col) / 2;
    col.length = 0;
    for (const { it } of want) {
      col.push(it);
      if (it.kind === "node") top.set(it.sized, at);
      else laneAt.set(`${it.link.id}@${c}`, at + it.h / 2);
      at += it.h + GAP_Y;
    }
  });

  const centre = BOX_HEADER + BOX_PAD + contentH / 2;
  items.forEach((col, c) => {
    const { x: cx, w } = xs[c]!;
    for (const it of col) {
      if (it.kind === "node")
        placed.push({ sized: it.sized, x: cx + (w - it.sized.w) / 2, y: centre + top.get(it.sized)!, col: xs[c]! });
      else (lanes[it.link.id] ??= []).push({ x0: cx, x1: cx + w, y: centre + laneAt.get(`${it.link.id}@${c}`)! });
    }
  });

  return { node, open, w: left + contentW + right, h: BOX_HEADER + BOX_PAD * 2 + contentH, placed, lanes };
}

/** One connection inside a container, with the columns of its two ends. */
interface Link {
  readonly id: string;
  /** -1 is the container's own input border. */
  readonly fromCol: number;
  /** One past the last column is its output border. */
  readonly toCol: number;
  readonly source: { kind: "input"; port: string } | { kind: "node"; sized: Sized; port: string };
  /** The box it lands on, and on which port; absent for a returned output. */
  readonly target?: Sized;
  readonly port?: string;
}

function connections(
  node: GraphNode,
  children: readonly Sized[],
  layer: ReadonlyMap<string, number>,
  columns: number,
): Link[] {
  const byId = new Map(children.map((c) => [c.node.id, c]));
  const split = (from: string): [string, string] => {
    const dot = from.indexOf(".");
    return dot < 0 ? [from, ""] : [from.slice(0, dot), from.slice(dot + 1)];
  };
  const out: Link[] = [];
  for (const c of children) {
    const toCol = layer.get(c.node.id) ?? 0;
    for (const [port, b] of Object.entries(c.node.bindings)) {
      const [head, tail] = split(b.from);
      const id = laneId(c.node.id, port);
      if (head === "inputs") {
        out.push({ id, fromCol: -1, toCol, source: { kind: "input", port: tail }, target: c, port });
        continue;
      }
      const src = byId.get(head);
      if (src && src !== c)
        out.push({ id, fromCol: layer.get(src.node.id) ?? 0, toCol, source: { kind: "node", sized: src, port: tail }, target: c, port });
    }
  }
  for (const [port, sources] of Object.entries(node.returns))
    for (const from of sources) {
      const [head, tail] = split(from);
      const src = byId.get(head);
      if (src)
        out.push({ id: returnId(port, head), fromCol: layer.get(src.node.id) ?? 0, toCol: columns, source: { kind: "node", sized: src, port: tail } });
    }
  return out;
}

function inputAnchors(s: Sized): Anchor[] {
  if (!s.open)
    return s.node.inputs.map((port, i) => ({ port, x: 0, y: HEADER_H + i * PORT_ROW + PORT_ROW / 2 }));
  const n = s.node.inputs.length;
  return s.node.inputs.map((port, i) => ({
    port,
    x: 0,
    y: BOX_HEADER + ((s.h - BOX_HEADER) * (i + 1)) / (n + 1),
  }));
}

function outputAnchors(s: Sized): Anchor[] {
  if (!s.open)
    return s.node.outputs.map((port, i) => ({
      port,
      x: s.w,
      y: HEADER_H + i * PORT_ROW + PORT_ROW / 2,
    }));
  const ports = Object.keys(s.node.returns);
  return ports.map((port, i) => ({
    port,
    x: s.w,
    y: BOX_HEADER + ((s.h - BOX_HEADER) * (i + 1)) / (ports.length + 1),
  }));
}

export const GRAPH_METRICS = { NODE_W, HEADER_H, PORT_ROW, BOX_HEADER, BOX_PAD };
