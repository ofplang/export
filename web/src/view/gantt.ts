/**
 * Draw a Gantt layout as SVG.
 *
 * Three elements share one geometry: a sticky label gutter, a time axis that
 * scrolls with the plot, and the plot itself. Colours live in the stylesheet,
 * so the same markup serves both themes; only the export path (`view/export`)
 * needs them resolved.
 */

import { ganttLayout, type GanttView } from "../layout/gantt";
import { makeScale, unitAbbrev, type Scale } from "../layout/scale";
import type { Scene } from "../model/scene";

export const LANE_H = 27;
const LANE_H_MAX = 44;
const BAR_H = 13;
const HELD_H = 4;
const WAIT_H = 2;
const AXIS_H = 27;
export const GUTTER_W = 176;

export interface GanttGeometry {
  readonly gutter: string;
  readonly axis: string;
  readonly plot: string;
  readonly width: number;
  readonly height: number;
  readonly scale: Scale;
}

export interface GanttOptions {
  readonly view: GanttView;
  /** Plot width in px before zoom. */
  readonly baseWidth: number;
  readonly zoom: number;
  /** Activity indices to emphasise; everything else dims. Empty = no selection. */
  readonly lit: ReadonlySet<number>;
  /**
   * A selected Object. In the Object view its own lane lights and no other —
   * a step two Objects share is on both lanes, but only one was picked.
   */
  readonly litObject?: string;
  /** One activity picked within that Object: its bar on that lane stands out (D62). */
  readonly focus?: number;
  readonly showLabels: boolean;
  /** Height of the box the chart sits in; short charts grow to fill it. */
  readonly availableHeight?: number;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Clip from the middle, keeping more of the end than of the start. */
const clipMiddle = (s: string, n: number): string => {
  if (s.length <= n) return s;
  const head = Math.floor((n - 1) / 3);
  return `${s.slice(0, head)}…${s.slice(s.length - (n - 1 - head))}`;
};

/** One decimal is plenty for SVG coordinates, and keeps the markup readable. */
const r = (n: number): number => Math.round(n * 10) / 10;

/** IBM Plex Mono at 9.5px runs about 5.7px to the character. */
const CH = 5.7;

/** The label, trimmed to the room available — or nothing, if there is none. */
function fit(label: string, room: number): string {
  if (room < CH * 3) return "";
  const max = Math.floor(room / CH);
  return label.length <= max ? label : clip(label, max);
}

export function renderGantt(scene: Scene, opts: GanttOptions): GanttGeometry {
  const { lanes, bars } = ganttLayout(scene, opts.view);
  // A four-lane plan stranded at the top of a tall pane looks unfinished. Give
  // the lanes the spare room, up to a point — past that the rows stop reading
  // as one chart.
  const laneH =
    opts.availableHeight && lanes.length
      ? Math.max(LANE_H, Math.min(LANE_H_MAX, Math.floor((opts.availableHeight - 6) / lanes.length)))
      : LANE_H;
  const height = Math.max(lanes.length * laneH + 4, 48);
  const width = Math.max(240, opts.baseWidth * opts.zoom);
  const scale = makeScale(Math.max(scene.metrics.makespan, scene.metrics.horizon), width);
  const active = opts.lit.size > 0 || opts.litObject !== undefined;

  const gutter: string[] = [];
  const plot: string[] = [];

  lanes.forEach((lane, i) => {
    const y = i * laneH;
    if (i % 2) {
      gutter.push(`<rect class="lane-alt" x="0" y="${y}" width="${GUTTER_W}" height="${laneH}"/>`);
      plot.push(`<rect class="lane-alt" x="0" y="${y}" width="${width}" height="${laneH}"/>`);
    }
    const shown = lane.elide === "middle" ? clipMiddle(lane.label, 21) : clip(lane.label, 21);
    // A clipped label keeps its whole text as a tooltip.
    const whole = shown === lane.label ? "" : `<title>${esc(lane.label)}</title>`;
    const pick = lane.object
      ? ` data-o="${esc(lane.object)}"${lane.object === opts.litObject ? ` class="lane-label pick lit"` : ` class="lane-label pick"`}`
      : ` class="lane-label"`;
    gutter.push(`<text${pick} x="10" y="${y + laneH / 2 + 3.5}">${whole}${esc(shown)}</text>`);
    if (lane.tag)
      gutter.push(
        `<text class="lane-tag" x="${GUTTER_W - 8}" y="${y + laneH / 2 + 3}" text-anchor="end">${esc(lane.tag)}</text>`,
      );
    gutter.push(`<line class="lane-rule" x1="0" y1="${y + laneH}" x2="${GUTTER_W}" y2="${y + laneH}"/>`);
    plot.push(`<line class="lane-rule" x1="0" y1="${y + laneH}" x2="${width}" y2="${y + laneH}"/>`);
  });

  for (const t of scale.ticks)
    plot.push(`<line class="grid-ln" x1="${scale.x(t)}" y1="0" x2="${scale.x(t)}" y2="${height}"/>`);

  // Labels are placed against their neighbours, not just against the plot
  // edge: a bar's caption sits in the gap before whatever comes next on the
  // same lane, and is dropped when that gap is too small. Without this a busy
  // lane — a single transporter running 22 moves — renders as overlapping
  // fragments of a dozen words.
  const occupied = new Map<number, number[]>();
  for (const bar of bars) {
    const list = occupied.get(bar.lane);
    if (list) list.push(scale.x(bar.start));
    else occupied.set(bar.lane, [scale.x(bar.start)]);
  }
  for (const list of occupied.values()) list.sort((a, b) => a - b);
  const nextStartOn = (lane: number, after: number): number => {
    for (const x of occupied.get(lane) ?? []) if (x > after + 0.5) return x;
    return width;
  };

  for (const bar of bars) {
    const a = bar.index === undefined ? undefined : scene.activities[bar.index];
    const y = bar.lane * laneH + (laneH - BAR_H) / 2;
    const isLit =
      opts.litObject !== undefined && bar.object !== undefined
        ? bar.object === opts.litObject
        : bar.index !== undefined && opts.lit.has(bar.index);
    const on = !active || isLit;
    const cls = [
      "bar",
      bar.style,
      a?.status === "completed" ? "done" : "",
      // Work that stands on an outcome the plan only assumes (§6.14): outlined
      // dashed, the cue that does not rest on colour.
      // A held or kept band is too thin to carry a dash, and its move says it.
      bar.index !== undefined && scene.assumed.has(bar.index) && bar.style !== "held" && bar.style !== "reserved"
        ? "assumed"
        : "",
      active && isLit ? "lit" : "",
      isLit && opts.focus !== undefined && bar.index === opts.focus ? "focus" : "",
      active && !on ? "dim" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const ids = `${bar.index === undefined ? "" : ` data-i="${bar.index}"`}${bar.object ? ` data-o="${esc(bar.object)}"` : ""}`;

    if (bar.style === "relay" || bar.style === "gate") {
      // A relay (§6.4.1) and a gate (§6.15) are instantaneous — a point, drawn
      // as a small diamond; a gate's is hollow.
      const cx = scale.x(bar.start);
      const cy = y + BAR_H / 2;
      plot.push(
        `<rect class="${cls}"${ids} x="${cx - 4}" y="${cy - 4}" width="8" height="8" transform="rotate(45 ${cx} ${cy})"/>`,
      );
      continue;
    }

    if (bar.style === "decision") {
      // A decision is a moment too (§6.14): a marker pointing down at it, and
      // what it decides beside it — the `?` of an assumed one included.
      const cx = scale.x(bar.start);
      plot.push(
        `<path class="${cls}"${ids} d="M ${r(cx - 5)} ${r(y + 1)} H ${r(cx + 5)} L ${r(cx)} ${r(y + BAR_H - 1)} Z"/>`,
      );
      const room = nextStartOn(bar.lane, cx) - cx - 12;
      const text = opts.showLabels ? fit(bar.label, room) : "";
      if (text) plot.push(`<text class="bar-tx outside" x="${r(cx + 8)}" y="${y + BAR_H - 3.5}">${esc(text)}</text>`);
      continue;
    }

    if (bar.style === "waiting") {
      // An Object sitting on a spot: a thin line joining what happens to it, so
      // a lane reads as one life rather than as unrelated bars.
      const x0 = scale.x(bar.start);
      const x1 = scale.x(bar.end);
      const w = Math.max(0, x1 - x0);
      plot.push(
        `<rect class="${cls}" x="${x0}" y="${y + BAR_H / 2 - WAIT_H / 2}" width="${w}" height="${WAIT_H}"/>`,
        // A 2px line is too thin to hit: an invisible band the height of a bar
        // carries its identity, and what the hover card says about it.
        `<rect class="wait-hit"${ids} data-wait="${bar.start} ${bar.end}" x="${x0}" y="${y}" width="${w}" height="${BAR_H}"/>`,
      );
      continue;
    }

    const x0 = scale.x(bar.start);
    const x1 = scale.x(bar.end);
    // A held device is secondary information — the machine is blocked, but
    // nothing is happening on it. A band under the row says that without
    // competing with the work itself. A kept spot (§6.16) is the same: nothing
    // happens on it for being kept, and what does happen there sits above.
    const held = bar.style === "held" || bar.style === "reserved";
    const w = Math.max(2.5, x1 - x0 - 2);
    const h = held ? HELD_H : BAR_H;
    plot.push(
      `<rect class="${cls}"${ids} x="${x0 + 1}" y="${held ? y + BAR_H - HELD_H : y}" width="${w}" height="${h}"/>`,
    );

    if (bar.style === "replenishment") {
      // The mandatory non-colour cue: a refill separates from a move by a
      // colour distance the palette check only warns on, so it also carries a
      // shape, drawn whether or not the caption fits.
      const cy = y + BAR_H / 2;
      const cx = x0 + 1 + Math.min(w, 12) / 2;
      const a = Math.min(3, w / 3);
      plot.push(
        `<path class="refill-plus" d="M ${r(cx - a)} ${r(cy)} H ${r(cx + a)} M ${r(cx)} ${r(cy - a)} V ${r(cy + a)}"/>`,
      );
    }

    if (!opts.showLabels || !bar.label || held) continue;
    const baseline = y + BAR_H - 3.5;
    const indent = bar.style === "replenishment" ? 15 : 5;
    const inside = fit(bar.label, w - indent - 4);
    // A resting bar is hollow, so its caption takes the ink colour, not the on-fill one.
    if (inside)
      plot.push(
        `<text class="bar-tx${bar.style === "resting" ? " on-rest" : ""}" x="${x0 + indent}" y="${baseline}">${esc(inside)}</text>`,
      );
    else {
      const gap = nextStartOn(bar.lane, x0) - x1 - 9;
      const outside = fit(bar.label, gap);
      if (outside)
        plot.push(`<text class="bar-tx outside" x="${x1 + 5}" y="${baseline}">${esc(outside)}</text>`);
    }
  }

  const axis: string[] = [
    `<text class="axis-cap" x="6" y="11">TIME (${esc(unitAbbrev(scene.unit).toUpperCase())})</text>`,
  ];
  for (const t of scale.ticks)
    axis.push(`<text class="tick-tx" x="${scale.x(t)}" y="23" text-anchor="middle">${t}</text>`);

  if (typeof scene.doc.now === "number") {
    const nx = scale.x(scene.doc.now);
    plot.push(`<line class="nowline" x1="${nx}" y1="0" x2="${nx}" y2="${height}"/>`);
    axis.push(`<text class="nowcap" x="${nx}" y="11" text-anchor="middle">now</text>`);
  }

  return {
    gutter: gutter.join(""),
    axis: axis.join(""),
    plot: plot.join(""),
    width,
    height,
    scale,
  };
}

export const AXIS_HEIGHT = AXIS_H;
