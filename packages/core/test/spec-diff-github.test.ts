import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSpec } from "../src/spec/load.js";
import { diffSpecs } from "../src/spec/diff.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../..", "fixtures/specs/downloaded");
const ready = existsSync(join(dir, "github-a.json")) && existsSync(join(dir, "github-b.json"));

describe.skipIf(process.env.AUTOSHIM_NET_TESTS !== "1" || !ready)("github REST spec pair", () => {
  it("diffs two real revisions in under 5s without exploding", () => {
    const a = loadSpec(readFileSync(join(dir, "github-a.json"), "utf8"));
    const b = loadSpec(readFileSync(join(dir, "github-b.json"), "utf8"));
    const t0 = performance.now();
    const d = diffSpecs(a, b);
    expect(performance.now() - t0).toBeLessThan(5000);
    const total = d.specDiff.addedPaths.length + d.specDiff.removedPaths.length + d.specDiff.changedOperations.length;
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(5000);
  });
});
