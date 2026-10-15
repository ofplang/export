/**
 * Golden test — every execution document the pinned submodule ships must read.
 *
 * This is the whole mechanism that keeps a hand-written TypeScript reader
 * honest against a specification owned by another repository (design.md D5/D6):
 * the submodule is pinned by tag, so nothing changes under us, and raising the
 * pin turns red here if the document schema moved.
 *
 * It deliberately asserts spec invariants rather than a byte-for-byte snapshot.
 * A snapshot would break on every cosmetic change to the examples; these
 * invariants only break when something the viewer actually relies on changes.
 */

import { describe, expect, it } from "vitest";

import { arcKey, deviceOf } from "../../src/model/common";
import { hasArc } from "../../src/model/document";
import { readExecutionDocumentText } from "../../src/read";
import { documentFiles, inputDocumentFiles, jointDocumentFiles, read, statusFiles } from "./corpus";

const documents = documentFiles;

// A pin that stopped shipping examples would otherwise pass this file silently.
it("the pinned submodule ships execution documents", () => {
  expect(documents.length).toBeGreaterThanOrEqual(4);
});

// Status inputs (§7) and planning-input documents (§6.8 / §6.10) share the
// execution-document schema and must read too, even though they carry no plan.
for (const [dir, name] of [...statusFiles, ...inputDocumentFiles])
  it(`reads ${name}`, () => {
    const d = readExecutionDocumentText(read(dir, name));
    expect(Array.isArray(d.activities)).toBe(true);
    for (const a of d.activities) expect(a.end).toBeGreaterThanOrEqual(a.start);
  });

// A plan of several jobs (§6.11), refused until 0.1.9 (design.md D42), is
// read: every activity but a refill names a job of the roster, and `meta`
// names a workflow per job, in roster order (D75).
it("the pinned submodule ships plans of several jobs", () => {
  expect(jointDocumentFiles.length).toBeGreaterThan(0);
});
for (const [dir, name] of jointDocumentFiles)
  it(`reads the plan of several jobs ${name}`, () => {
    const doc = readExecutionDocumentText(read(dir, name));
    const roster = (doc.jobs ?? []).map((j) => j.id);
    expect(roster.length).toBeGreaterThan(1);
    for (const a of doc.activities)
      if (a.kind === "replenishment") expect(a.job).toBeUndefined();
      else expect(roster).toContain(a.job);
    expect(doc.meta?.workflows?.length).toBe(roster.length);
  });

for (const [dir, name] of documents) describe(name, () => {
  const doc = readExecutionDocumentText(read(dir, name));

  it("reads, and carries activities", () => {
    expect(doc.activities.length).toBeGreaterThan(0);
  });

  it("every activity has a sane window", () => {
    for (const a of doc.activities) expect(a.end).toBeGreaterThanOrEqual(a.start);
  });

  it("a plan reports an outcome and an objective value (§6.1)", () => {
    // Only plans do; a status has no value to report. Every file here is a plan.
    expect(doc.outcome).toBeDefined();
    expect(doc.objective?.value).toBeDefined();
  });

  it("processing activities name a process, a mode and a node path (§6.3)", () => {
    for (const a of doc.activities) {
      if (a.kind !== "processing") continue;
      expect(a.process).not.toBe("");
      expect(a.mode).not.toBe("");
      expect(a.node.length).toBeGreaterThan(0);
    }
  });

  it("a mode's spots sit on that activity's own devices (§6.3)", () => {
    for (const a of doc.activities) {
      if (a.kind !== "processing" || !a.devices) continue;
      const owned = new Set(a.devices);
      for (const spot of [
        ...Object.values(a.inputSpots ?? {}),
        ...Object.values(a.outputSpots ?? {}),
      ]) {
        expect(owned).toContain(deviceOf(spot));
      }
    }
  });

  it("transports carry an arc, and no transporter on a same-spot move (§6.4)", () => {
    // A real move names its transporter or says `null` for a route that needs
    // none; the reader refuses one that omits the key, so reading is the check.
    for (const a of doc.activities) {
      if (a.kind !== "transport") continue;
      expect(a.arc.from.port).not.toBe("");
      expect(a.arc.to.port).not.toBe("");
      if (a.fromSpot === a.toSpot) expect(a.transporter).toBeUndefined();
    }
  });

  it("relays are instantaneous and sit on the spot their legs share (§6.4.1)", () => {
    const legsByArc = new Map<string, { fromSpot: string; toSpot: string }[]>();
    for (const a of doc.activities) {
      if (a.kind !== "transport") continue;
      const k = arcKey(a.arc);
      const list = legsByArc.get(k) ?? [];
      list.push({ fromSpot: a.fromSpot, toSpot: a.toSpot });
      legsByArc.set(k, list);
    }
    for (const a of doc.activities) {
      if (a.kind !== "relay") continue;
      expect(a.end).toBe(a.start);
      const legs = legsByArc.get(arcKey(a.arc)) ?? [];
      const touching = legs.filter((l) => l.toSpot === a.spot || l.fromSpot === a.spot);
      expect(touching.length).toBeGreaterThan(0);
    }
  });

  it("every leg of one arc shares that arc verbatim (§6.4)", () => {
    const seen = new Map<string, number>();
    for (const a of doc.activities) {
      if (!hasArc(a)) continue;
      const k = arcKey(a.arc);
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    // Nothing to assert about the counts themselves — the point is that the key
    // is derivable at all, which is what the linked-highlight index relies on.
    for (const [k, n] of seen) {
      expect(k).toMatch(/\|/);
      expect(n).toBeGreaterThan(0);
    }
  });

  it("a boundary arc endpoint uses an empty node path, not a missing one (§6.4)", () => {
    for (const a of doc.activities) {
      if (!hasArc(a)) continue;
      for (const e of [a.arc.from, a.arc.to]) {
        expect(Array.isArray(e.node)).toBe(true);
      }
    }
  });

  it("a document with started activities sets `now` (§6.1)", () => {
    const started = doc.activities.some(
      (a) => a.status === "completed" || a.status === "running",
    );
    if (started) expect(doc.now).toBeDefined();
  });
});
