/**
 * Screenshots, so the person writing this can look at it.
 *
 * Not assertions — `npm run shots` writes PNGs into `web/shots/` and that is
 * the whole point. There is no browser in the environment this is developed
 * in, and two layout bugs shipped because of it.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { test, type Page } from "@playwright/test";

const DIR = fileURLToPath(new URL("../../shots/", import.meta.url));
mkdirSync(DIR, { recursive: true });

const shot = async (page: Page, name: string): Promise<void> => {
  await page.screenshot({ path: `${DIR}${name}.png`, fullPage: false });
};

const settle = async (page: Page): Promise<void> => {
  await page.locator("#plot rect.bar").first().waitFor();
  // Give the webfont a moment; a fallback-rendered shot is still readable but
  // the spacing is not what a viewer sees.
  await page.evaluate(() => document.fonts.ready);
};

test.describe.configure({ mode: "serial" });

/** Where on screen the middle of a drawn path is. */
async function midpointOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  return page.evaluate((sel) => {
    const p = document.querySelector<SVGPathElement>(sel)!;
    const m = p.getPointAtLength(p.getTotalLength() / 2).matrixTransform(p.getScreenCTM()!);
    return { x: m.x, y: m.y };
  }, selector);
}

test("the plans, in both themes", async ({ page }) => {
  for (const doc of ["simple", "two_arms", "reformatter", "plate_batch"]) {
    await page.goto(`/?doc=${doc}`);
    await settle(page);
    for (const theme of ["light", "dark"]) {
      await page.locator("#theme").selectOption(theme);
      await shot(page, `${doc}.device.${theme}`);
    }
  }
});

test("the three views of the big one", async ({ page }) => {
  await page.goto("/?doc=plate_batch");
  await settle(page);
  for (const view of ["device", "flow", "activity"]) {
    await page.locator(`#views button[data-view="${view}"]`).click();
    await shot(page, `plate_batch.${view}`);
  }
});

test("the Object view (design.md §23)", async ({ page }) => {
  for (const doc of ["plate_assay", "storage", "reformatter", "reroute_chain_replan", "data_flow", "plate_batch"]) {
    await page.goto(`/?doc=${doc}`);
    await settle(page);
    const button = page.locator('#views button[data-view="object"]');
    if ((await button.getAttribute("aria-disabled")) === "true") {
      // Not offered: hover it, so the shot shows the button and its reason.
      await button.hover();
      await shot(page, `${doc}.object.unavailable`);
      continue;
    }
    await button.click();
    for (const theme of ["light", "dark"]) {
      await page.locator("#theme").selectOption(theme);
      await shot(page, `${doc}.object.${theme}`);
    }
  }
});

test("an Object picked, in both panes", async ({ page }) => {
  await page.goto("/?doc=storage");
  await settle(page);
  await page.locator('#views button[data-view="object"]').click();
  await page.locator('#gutter [data-o="create:PrepB.plate"]').click();
  await shot(page, "storage.object.picked");
  // Then one of its activities, within it (D62).
  await page.locator('#plot rect.bar.transport[data-o="create:PrepB.plate"]').first().click();
  await shot(page, "storage.object.focus");

  await page.goto("/?doc=plate_batch");
  await settle(page);
  await page.locator('#views button[data-view="object"]').click();
  // A bar, not the label: in this view a bar picks its lane's Object.
  await page.locator('#plot rect.bar.processing[data-o="create:source.plate_2"]').nth(3).click();
  await shot(page, "plate_batch.object.picked.collapsed");
  await page.locator("#expand-all").click();
  await page.locator("#graph-fit").click();
  await shot(page, "plate_batch.object.picked.expanded");

  // The same Object stays picked in another view, lit by its activities.
  await page.locator('#views button[data-view="device"]').click();
  await shot(page, "plate_batch.object.picked.device");
});

test("the workflow graph, and the link between the panes", async ({ page }) => {
  await page.goto("/?doc=plate_batch");
  await settle(page);
  await shot(page, "graph.collapsed");

  await page.locator('#graph [data-key="b2"] .btext').click();
  await shot(page, "graph.one-branch-open");

  await page.locator("#expand-all").click();
  await shot(page, "graph.expanded");

  await page.locator("#collapse-all").click();
  await page.locator("#plot rect.bar.processing").nth(6).click();
  await shot(page, "linked.bar-to-box");

  await page.locator('#graph [data-key="b1"] rect.box').click();
  await shot(page, "linked.box-to-bars");

  await page.locator('#graph .edge-hit[data-from="source"][data-to="b1"]').click();
  await shot(page, "linked.arc-to-moves");
});

test("the graph of a wide fan-out", async ({ page }) => {
  await page.goto("/?doc=reformatter");
  await settle(page);
  await shot(page, "graph.reformatter");
});

test("a replan, and a selection", async ({ page }) => {
  await page.goto("/?doc=simple_replan");
  await settle(page);
  await shot(page, "replan.now-marker");

  await page.goto("/?doc=reroute_chain_replan");
  await settle(page);
  await page.locator(`#views button[data-view="flow"]`).click();
  await page.locator("#plot rect.bar.transport").first().click();
  await shot(page, "selection.multi-leg");
});

test("a step resting on a device that stays free (§4.4.2)", async ({ page }) => {
  await page.goto("/?doc=storage");
  await settle(page);
  for (const theme of ["light", "dark"]) {
    await page.locator("#theme").selectOption(theme);
    await shot(page, `storage.device.${theme}`);
  }
  await page.locator("#plot rect.bar.resting").first().click();
  await shot(page, "storage.selected");
});

test("a plan of several jobs, together and one at a time (D75)", async ({ page }) => {
  await page.goto("/?doc=stopped_job");
  await settle(page);
  await shot(page, "jobs.device");
  await page.locator('#views button[data-view="flow"]').click();
  await shot(page, "jobs.flow");
  await page.locator("#job").selectOption("job3");
  await page.waitForTimeout(200);
  await shot(page, "jobs.flow.job3");
  await page.locator('#views button[data-view="object"]').click();
  await page.waitForTimeout(200);
  await shot(page, "jobs.object.job3");
  // Dropped on its own, with no workflow to draw it against.
  const text = readFileSync(
    fileURLToPath(new URL("../../../external/ofplang-schedule/examples/outputs/shared_bay.plan.yaml", import.meta.url)),
    "utf8",
  );
  await page.evaluate((yaml) => {
    const dt = new DataTransfer();
    dt.items.add(new File([yaml], "shared_bay.plan.yaml"));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, text);
  await settle(page);
  await shot(page, "jobs.dropped");
});

test("Pure Data, and an entry with inputs and outputs (data_flow)", async ({ page }) => {
  await page.goto("/?doc=data_flow");
  await settle(page);
  await page.locator("#expand-all").click();
  await shot(page, "data_flow.expanded");
  // Clicked by position, as a person would: this arc shares its first stretch
  // with the one to the workflow's output, and the nearer curve must win.
  const at = await midpointOf(page, '#graph .edge-hit[data-from="Az"][data-to="Finish"]');
  await page.mouse.click(at.x, at.y);
  await shot(page, "data_flow.pure-data-arc");
});

test("one pane on its own (D46)", async ({ page }) => {
  await page.goto("/?doc=plate_batch&layout=workflow");
  await page.locator("#graph g.gnode").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await shot(page, "layout.workflow");
  await page.locator('#layouts [data-layout="plan"]').click();
  await settle(page);
  await shot(page, "layout.plan");

  // The rail carries the layout switch and the link now; it must still fit
  // where the inspector has already folded away.
  await page.setViewportSize({ width: 960, height: 700 });
  await page.waitForTimeout(300); // the chart redraws on a debounced resize
  await shot(page, "layout.narrow");
});

test("the feature gate, refusing something it cannot draw", async ({ page }) => {
  await page.goto("/?doc=plate_batch");
  await settle(page);
  // Nothing in the corpus trips it, so the banner is staged here rather than
  // waited for — this shot exists to check that it reads well, not that it fires.
  await page.evaluate(() => {
    const banner = document.getElementById("banner")!;
    banner.innerHTML =
      "<div><b>This viewer cannot draw a generic process (`type_params`) faithfully, so parts of the graph are left out.</b>" +
      "<ul><li>a generic process (`type_params`) at <code>processes.wash.type_params</code> — the viewer does not instantiate generics, so it cannot say what this process's ports carry (§8)</li></ul></div>";
    banner.hidden = false;
  });
  await shot(page, "gate.banner");
});

test("structured nodes: a map of branches, a loop, a fold", async ({ page }) => {
  for (const doc of ["inspect_then_wash", "rinse_until_clean", "dispense_read", "wash_or_polish"]) {
    await page.goto(`/?doc=${doc}`);
    await settle(page);
    await page.locator("#expand-all").click();
    await page.waitForTimeout(200);
    await shot(page, `${doc}.structured.device`);
    for (const view of ["flow", "object"]) {
      await page.locator(`#views button[data-view="${view}"]`).click();
      await page.waitForTimeout(200);
      await shot(page, `${doc}.structured.${view}`);
    }
  }
  // An arm picked: the steps it ran, and only those, light in the plan.
  await page.goto("/?doc=inspect_then_wash");
  await settle(page);
  await page.locator("#expand-all").click();
  await page.locator('[data-key="Each.Choose.@then"]').first().click();
  await page.waitForTimeout(200);
  await shot(page, "inspect_then_wash.structured.arm");
});
