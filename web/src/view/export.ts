/**
 * Export the chart as a standalone SVG file.
 *
 * The live chart takes its colours from CSS custom properties, which do not
 * survive being pulled out of the page. So the export resolves the tokens for
 * whichever theme is on screen and writes them into the file as a `<style>`
 * block — the result opens in a browser, drops into a slide, and matches what
 * the person exporting it was looking at.
 */

import { AXIS_HEIGHT, GUTTER_W, type GanttGeometry } from "./gantt";

const TOKENS = [
  "--panel",
  "--sunken",
  "--border",
  "--hairline",
  "--ink",
  "--ink-2",
  "--muted",
  "--faint",
  "--processing",
  "--transport",
  "--replenishment",
  "--on-data",
  "--now",
] as const;

/**
 * The subset of the stylesheet the chart markup uses. Every bar style the layouts
 * draw needs a rule here, or an exported chart loses it (`tests/export.test.ts`).
 */
export function chartStyle(resolve: (token: string) => string): string {
  const v = (t: string): string => resolve(t) || "#000";
  return `
    .lane-alt { fill: ${v("--sunken")}; opacity: .5 }
    .lane-rule { stroke: ${v("--hairline")}; stroke-width: 1 }
    .lane-label { fill: ${v("--ink-2")}; font-family: "IBM Plex Sans Condensed","IBM Plex Sans",sans-serif; font-size: 10.5px; font-weight: 500 }
    .lane-tag { fill: ${v("--faint")}; font-family: "IBM Plex Mono",monospace; font-size: 8.5px }
    .grid-ln { stroke: ${v("--hairline")}; stroke-width: 1 }
    .tick-tx { fill: ${v("--faint")}; font-size: 9.5px; font-variant-numeric: tabular-nums }
    .axis-cap { fill: ${v("--muted")}; font-family: "IBM Plex Sans Condensed",sans-serif; font-size: 9.5px; font-weight: 600; letter-spacing: .08em }
    .bar { rx: 3 }
    .bar.processing { fill: ${v("--processing")} }
    .bar.resting { fill: ${v("--processing")}; fill-opacity: .12; stroke: ${v("--processing")}; stroke-width: 1.5 }
    .bar-tx.on-rest { fill: ${v("--ink-2")} }
    .bar.transport, .bar.relay { fill: ${v("--transport")} }
    .bar.replenishment { fill: ${v("--replenishment")} }
    .refill-plus { stroke: ${v("--on-data")}; stroke-width: 1.4; stroke-linecap: round }
    .bar.held { fill: ${v("--transport")}; fill-opacity: .42; rx: 1 }
    .bar.waiting { fill: ${v("--muted")}; rx: 0 }
    .bar.reserved { fill: ${v("--muted")}; fill-opacity: .5; rx: 1 }
    .bar.gate { fill: ${v("--panel")}; stroke: ${v("--transport")}; stroke-width: 1.5 }
    .bar.decision { fill: ${v("--ink-2")} }
    .bar.assumed { stroke: ${v("--ink-2")}; stroke-width: 1.2; stroke-dasharray: 3 2 }
    .wait-hit { fill: none }
    .bar.done { opacity: .55 }
    .bar.dim { opacity: .16 }
    .bar.lit { stroke: ${v("--ink")}; stroke-width: 2 }
    .bar.focus { stroke-width: 3.5 }
    .bar-tx { fill: ${v("--on-data")}; font-family: "IBM Plex Mono",monospace; font-size: 9.5px }
    .bar-tx.outside { fill: ${v("--muted")} }
    .nowline { stroke: ${v("--now")}; stroke-width: 1.5; stroke-dasharray: 4 3 }
    .nowcap { fill: ${v("--now")}; font-size: 9.5px; font-weight: 600 }
    .frame { fill: ${v("--panel")} }
    .divider { stroke: ${v("--border")}; stroke-width: 1 }
  `;
}

export function ganttToSvg(g: GanttGeometry, title: string, root: HTMLElement): string {
  const computed = getComputedStyle(root);
  const resolve = (token: string): string => computed.getPropertyValue(token).trim();

  const width = GUTTER_W + g.width;
  const height = AXIS_HEIGHT + g.height;
  const tokenComment = TOKENS.map((t) => `${t}: ${resolve(t)}`).join("; ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttr(title)}">
<title>${escapeText(title)}</title>
<!-- ${escapeText(tokenComment)} -->
<style>${chartStyle(resolve)}</style>
<rect class="frame" x="0" y="0" width="${width}" height="${height}"/>
<g transform="translate(${GUTTER_W},0)">${g.axis}</g>
<line class="divider" x1="${GUTTER_W}" y1="0" x2="${GUTTER_W}" y2="${height}"/>
<line class="divider" x1="0" y1="${AXIS_HEIGHT}" x2="${width}" y2="${AXIS_HEIGHT}"/>
<g transform="translate(0,${AXIS_HEIGHT})">${g.gutter}</g>
<g transform="translate(${GUTTER_W},${AXIS_HEIGHT})">${g.plot}</g>
</svg>
`;
}

export function downloadSvg(svg: string, filename: string): void {
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next turn of the loop; revoking immediately races the click
  // in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const escapeText = (s: string): string => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, "&quot;");
