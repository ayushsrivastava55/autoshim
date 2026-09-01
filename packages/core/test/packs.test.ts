import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePack, loadPacks } from "../src/packs.js";

const packsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../packs");
const readAll = () =>
  readdirSync(packsDir).filter((f) => f.endsWith(".yaml") && !f.startsWith("_"))
    .map((f) => readFileSync(join(packsDir, f), "utf8"));

describe("packs", () => {
  it("all bundled packs parse and include the 5 seeds", () => {
    const reg = loadPacks(readAll());
    for (const id of ["stripe", "github", "openai", "shopify", "slack"]) {
      expect(reg.byId(id), id).toBeDefined();
    }
  });
  it("maps npm package name to pack", () => {
    const reg = loadPacks(readAll());
    expect(reg.byPackage("npm", "stripe")?.id).toBe("stripe");
    expect(reg.byPackage("pypi", "openai")?.id).toBe("openai");
    expect(reg.byPackage("npm", "left-pad")).toBeUndefined();
  });
  it("rejects duplicate package claims across packs", () => {
    const a = `id: a\ndisplay_name: A\npackages:\n  npm: [dupe]\nimport_patterns: {}\nwatch: []\n`;
    const b = `id: b\ndisplay_name: B\npackages:\n  npm: [dupe]\nimport_patterns: {}\nwatch: []\n`;
    expect(() => loadPacks([a, b])).toThrow(/dupe/);
  });
  it("rejects a pack with no id", () => {
    expect(() => parsePack("display_name: X\npackages: {}\nimport_patterns: {}\nwatch: []")).toThrow();
  });
  it("vendorFor produces a pack-kind Vendor with flattened sdk_packages", () => {
    const reg = loadPacks(readAll());
    const v = reg.vendorFor(reg.byId("stripe")!);
    expect(v.kind).toBe("pack");
    expect(v.sdk_packages).toContainEqual({ ecosystem: "npm", name: "stripe" });
  });
  it("rejects invalid YAML syntax", () => {
    expect(() => parsePack("id: test\n  invalid: [unclosed")).toThrow();
  });
  it("rejects unknown ecosystem keys in packages", () => {
    const yaml = `id: test\ndisplay_name: Test\npackages:\n  totallyNotAnEcosystem: [foo]\nimport_patterns: {}\nwatch: []\n`;
    expect(() => parsePack(yaml)).toThrow();
  });
  it("rejects non-array package values", () => {
    const yaml = `id: test\ndisplay_name: Test\npackages:\n  npm: "not-an-array"\nimport_patterns: {}\nwatch: []\n`;
    expect(() => parsePack(yaml)).toThrow();
  });
});
