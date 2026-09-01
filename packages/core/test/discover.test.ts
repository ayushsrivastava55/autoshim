import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest, discover, detectLanguages } from "../src/discover.js";
import { loadPacks } from "../src/packs.js";
import type { RepoAccess } from "../src/types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const fx = (p: string) => readFileSync(join(root, "fixtures/manifests", p), "utf8");
const packs = () => {
  const dir = join(root, "packs");
  return loadPacks(readdirSync(dir).filter((f) => f.endsWith(".yaml") && !f.startsWith("_")).map((f) => readFileSync(join(dir, f), "utf8")));
};

describe("parseManifest", () => {
  it("package.json: deps only, not devDeps", () => {
    const out = parseManifest("package.json", fx("js/package.json"));
    const names = out.map((d) => d.package_name);
    expect(names).toContain("stripe");
    expect(names).toContain("klaviyo-api");
    expect(names).not.toContain("vitest");
    expect(out[0].ecosystem).toBe("npm");
    expect(out[0].confidence).toBe(0.9);
  });
  it("requirements.txt: strips versions, extras, markers, comments", () => {
    const names = parseManifest("requirements.txt", fx("py/requirements.txt")).map((d) => d.package_name);
    expect(names).toEqual(["openai", "requests", "slack-sdk"]);
  });
  it("pyproject.toml: project.dependencies + poetry deps, skips python", () => {
    const names = parseManifest("pyproject.toml", fx("py/pyproject.toml")).map((d) => d.package_name);
    expect(names).toContain("stripe");
    expect(names).toContain("ShopifyAPI");
    expect(names).not.toContain("python");
  });
  it("go.mod require block", () => {
    const names = parseManifest("go.mod", fx("go/go.mod")).map((d) => d.package_name);
    expect(names).toContain("github.com/stripe/stripe-go/v79");
  });
  it("Gemfile.lock specs", () => {
    const out = parseManifest("Gemfile.lock", fx("rb/Gemfile.lock"));
    expect(out.map((d) => d.package_name)).toEqual(["stripe", "rake"]);
    expect(out[0].confidence).toBe(0.6);
  });
  it("package-lock.json with scoped packages", () => {
    const names = parseManifest("package-lock.json", fx("js/package-lock.json")).map((d) => d.package_name);
    expect(names).toContain("lodash");
    expect(names).toContain("@stripe/stripe-js");
    expect(names).toContain("@babel/core");
  });
  it("pnpm-lock.yaml v6+ format with specifier/version nesting", () => {
    const names = parseManifest("pnpm-lock.yaml", fx("js/pnpm-lock.yaml")).map((d) => d.package_name);
    expect(names).toContain("react");
    expect(names).toContain("vue");
    expect(names).toContain("typescript");
    expect(names).not.toContain("specifier");
    expect(names).not.toContain("version");
  });
  it("yarn.lock with scoped and quoted keys", () => {
    const names = parseManifest("yarn.lock", fx("js/yarn.lock")).map((d) => d.package_name);
    expect(names).toContain("@babel/core");
    expect(names).toContain("@stripe/stripe-js");
    expect(names).toContain("lodash");
    expect(names).toContain("react");
  });
  it("poetry.lock extracts all package sections", () => {
    const names = parseManifest("poetry.lock", fx("py/poetry.lock")).map((d) => d.package_name);
    expect(names).toEqual(["requests", "stripe"]);
    expect(names.length).toBe(2);
  });
});

describe("discover", () => {
  const repo: RepoAccess = {
    listFiles: async () => ["package.json", "src/app.ts"],
    read: async (p) => (p === "package.json" ? fx("js/package.json") : ""),
  };
  it("resolves known packages to pack ids, leaves unknown null", async () => {
    const out = await discover(repo, packs());
    expect(out.find((d) => d.package_name === "stripe")?.vendor_id).toBe("stripe");
    expect(out.find((d) => d.package_name === "klaviyo-api")?.vendor_id).toBeNull();
  });
});

describe("detectLanguages", () => {
  it("detects from extensions", () => {
    expect(detectLanguages(["a.ts", "b.py", "go.mod"])).toEqual(expect.arrayContaining(["typescript", "python", "go"]));
  });
});

describe("boundary cases", () => {
  it("empty manifest content returns empty array", () => {
    expect(parseManifest("package.json", "")).toEqual([]);
    expect(parseManifest("requirements.txt", "")).toEqual([]);
    expect(parseManifest("pyproject.toml", "")).toEqual([]);
  });

  it("whitespace-only manifest content returns empty array", () => {
    expect(parseManifest("package.json", "   \n\n  ")).toEqual([]);
    expect(parseManifest("requirements.txt", "  \n")).toEqual([]);
  });

  it("malformed JSON in package.json returns empty array", () => {
    expect(parseManifest("package.json", "{invalid json}")).toEqual([]);
    expect(parseManifest("package.json", '{"dependencies": {broken}}')).toEqual([]);
  });

  it("requirements.txt with only comments and blank lines returns empty array", () => {
    expect(parseManifest("requirements.txt", "# comment\n# another\n\n")).toEqual([]);
  });

  it("malformed TOML in pyproject.toml returns empty array", () => {
    expect(parseManifest("pyproject.toml", "[project\nbroken syntax")).toEqual([]);
  });

  it("malformed JSON in package-lock.json returns empty array", () => {
    expect(parseManifest("package-lock.json", "{invalid}")).toEqual([]);
  });

  it("malformed JSON in Pipfile.lock returns empty array", () => {
    expect(parseManifest("Pipfile.lock", "{invalid}")).toEqual([]);
  });

  it("detectLanguages with empty file list returns empty array", () => {
    expect(detectLanguages([])).toEqual([]);
  });

  it("detectLanguages with unknown extensions only", () => {
    expect(detectLanguages(["foo.txt", "bar.md", "baz.xyz"])).toEqual([]);
  });
});
