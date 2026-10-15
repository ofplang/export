/**
 * The exported SVG carries a rule for every mark the chart draws.
 *
 * The export writes its own stylesheet (`chartStyle`), since the page's custom
 * properties do not survive the trip. A bar style the layouts learn but the
 * export does not is drawn on screen and lost in the file — which is what
 * happened to decisions, gates, kept spots and assumed work in 0.1.8.
 */

import { describe, expect, it } from "vitest";

import { GANTT_VIEWS, ganttLayout } from "../src/layout/gantt";
import { buildScene } from "../src/model/scene";
import { readEnvironmentText, readExecutionDocumentText, readWorkflowText } from "../src/read";
import { chartStyle } from "../src/view/export";
import { documentFiles, read, triples } from "./golden/corpus";

const style = chartStyle(() => "#123456");

describe("every bar the corpus draws has a rule in the export", () => {
  const seen = new Set<string>();
  for (const [dir, name] of documentFiles) {
    const t = triples.find((x) => `${x.name}.plan.yaml` === name);
    const scene = buildScene(
      readExecutionDocumentText(read(dir, name)),
      t ? readEnvironmentText(read(...t.environment)) : undefined,
      t ? readWorkflowText(read(...t.workflow)) : undefined,
    );
    for (const v of GANTT_VIEWS) for (const b of ganttLayout(scene, v.id).bars) seen.add(b.style);
    if (scene.assumed.size) seen.add("assumed");
  }

  it("the corpus draws the new marks", () => {
    for (const s of ["decision", "gate", "reserved", "assumed"]) expect(seen).toContain(s);
  });

  for (const s of ["processing", "resting", "transport", "held", "relay", "replenishment", "waiting", "decision", "gate", "reserved", "assumed"])
    it(`.bar.${s}`, () => {
      expect(style).toMatch(new RegExp(`\\.bar\\.${s}\\b`));
    });

  it("and nothing the corpus draws is missing", () => {
    for (const s of seen) expect(style, s).toMatch(new RegExp(`\\.bar\\.${s}\\b`));
  });
});
