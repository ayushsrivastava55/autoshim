# Autoshim SP1 (CLI + core pipeline) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `autoshim` OSS CLI: discover a repo's API integrations, watch vendor contracts (OpenAPI polling, GitHub releases, Context.dev pages), classify changes, find impacted files, and open draft PRs / issues.

**Architecture:** pnpm monorepo. All pipeline logic lives in `@autoshim/core` as pure functions behind injected interfaces (`ChangeSource`, `RepoAccess`, `Publisher`, `LlmExtractor`, `HealAgent`, `fetchFn`); `packages/cli` is the first host wiring them to fs + git + Octokit. Every external service (Anthropic, Context.dev, GitHub, npm/PyPI registries) is faked in tests.

**Tech Stack:** TypeScript (strict, ESM), pnpm workspaces, vitest, commander, yaml, zod, @anthropic-ai/sdk, @octokit/rest, smol-toml, diff.

**Spec:** `docs/superpowers/specs/2026-08-26-autoshim-sp1-cli-core-design.md`

## Global Constraints

- Node >= 20 (`"engines": {"node": ">=20"}`); global `fetch` exists — always take it as an injectable `fetchFn: typeof fetch` parameter defaulting to `globalThis.fetch`.
- ESM everywhere (`"type": "module"`). Never use `__dirname`; derive script-relative paths from `import.meta.url`.
- License: Apache-2.0 (root `LICENSE`, `"license": "Apache-2.0"` in every package.json).
- Tests: vitest. **No live network in tests** — every HTTP/LLM/git call goes through an injected fake. Sole exception: the GitHub-spec perf test in Task 6, gated behind `process.env.AUTOSHIM_NET_TESTS === "1"` (skipped otherwise).
- Claude API (pinned from claude-api skill, 2026-09-01 — do NOT substitute trained priors): model `"claude-opus-5"` always; structured extraction via `client.messages.parse` + `zodOutputFormat` from `@anthropic-ai/sdk/helpers/zod`; the healer uses `client.messages.stream(...)` + `await stream.finalMessage()` (long output); NEVER pass `budget_tokens`, `temperature`, or an assistant prefill.
- Context.dev (verified 2026-09-01): base `https://api.context.dev/v1`, header `Authorization: Bearer $CONTEXT_API_KEY`. `GET/POST /v1/monitors` verified from docs curl examples. `GET /v1/monitors/{id}/changes` and `POST /v1/extract` are nav-inferred — Task 10 isolates all Context.dev HTTP in one file and its first step curls the real endpoint when `CONTEXT_API_KEY` is set (trust the doc shape otherwise).
- Runtime deps whitelist: `commander`, `yaml`, `zod`, `@anthropic-ai/sdk`, `@octokit/rest`, `smol-toml`, `diff`. Dev: `typescript`, `vitest`, `tsx`, `@types/node`, `@types/diff`. Do not add others.
- Commits: conventional (`feat:`, `test:`, `chore:`), one per task step-5, `git -c user.name=autoshim -c user.email=ayushsrivas55@gmail.com commit`.
- Product strings: branch `autoshim/<vendorId>/<fp8>`; PR title `fix(autoshim): adapt {vendor} {entity} ({classification})`; label `autoshim`; issue title `[autoshim] {Vendor} {title}`; PRs always `draft: true`; PR body footer `Opened by Autoshim. I will not auto-merge.`
- Safety caps (heal): max 20 files, max 400 changed lines total, edits only within allowed files (+1 extra file permitted for an import fix).
- Skip dirs everywhere: `node_modules`, `.venv`, `venv`, `dist`, `build`, `vendor`, `.git`, `.autoshim`, `__pycache__`, `coverage`, `.next`.

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `pnpm-workspace.yaml`, root `package.json`, `tsconfig.base.json`, `LICENSE`, `.gitignore`, `vitest.workspace.ts`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/test/smoke.test.ts`
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/src/index.ts`

**Interfaces:**
- Produces: workspace where `pnpm -r test` and `pnpm -r build` (tsc) pass; `@autoshim/core` importable from `packages/cli` via workspace protocol.

- [ ] **Step 1: Write files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
```

Root `package.json`:
```json
{
  "name": "autoshim-monorepo",
  "private": true,
  "license": "Apache-2.0",
  "engines": { "node": ">=20" },
  "scripts": { "test": "vitest run", "build": "pnpm -r build" },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^3.0.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`packages/core/package.json`:
```json
{
  "name": "@autoshim/core",
  "version": "0.1.0",
  "license": "Apache-2.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" },
  "dependencies": {
    "yaml": "^2.5.0",
    "zod": "^3.23.0",
    "@anthropic-ai/sdk": "^1.0.0",
    "smol-toml": "^1.3.0",
    "diff": "^7.0.0"
  },
  "devDependencies": { "@types/diff": "^6.0.0" }
}
```

`packages/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
```

`packages/cli/package.json`:
```json
{
  "name": "autoshim",
  "version": "0.1.0",
  "license": "Apache-2.0",
  "type": "module",
  "bin": { "autoshim": "dist/index.js" },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" },
  "dependencies": {
    "@autoshim/core": "workspace:*",
    "commander": "^12.1.0",
    "yaml": "^2.5.0",
    "@octokit/rest": "^21.0.0"
  }
}
```

`packages/cli/tsconfig.json`: same shape as core's. `packages/cli/src/index.ts`:
```typescript
#!/usr/bin/env node
export {};
```

`packages/core/src/index.ts`:
```typescript
export const CORE_VERSION = "0.1.0";
```

`vitest.workspace.ts`:
```typescript
export default ["packages/*"];
```

`.gitignore`:
```
node_modules/
dist/
.autoshim/cache/
.autoshim/changes/
fixtures/specs/downloaded/
```

`LICENSE`: the full Apache-2.0 text (fetch from https://www.apache.org/licenses/LICENSE-2.0.txt).

`packages/core/test/smoke.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { CORE_VERSION } from "../src/index.js";

describe("workspace", () => {
  it("core is importable", () => {
    expect(CORE_VERSION).toBe("0.1.0");
  });
});
```

- [ ] **Step 2: Install & verify fail-free baseline**

Run: `pnpm install && pnpm -r build && pnpm test`
Expected: build passes, 1 test passes.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: scaffold pnpm monorepo (core + cli)"
```

---

### Task 2: Core types + fingerprint

**Files:**
- Create: `packages/core/src/types.ts`, `packages/core/src/fingerprint.ts`
- Modify: `packages/core/src/index.ts` (re-export both)
- Test: `packages/core/test/fingerprint.test.ts`

**Interfaces:**
- Produces (every later task imports these EXACT names from `@autoshim/core`):

```typescript
// ---- types.ts (verbatim; later tasks must not rename anything here) ----
export type Classification = "breaking" | "deprecation" | "additive" | "docs_only" | "unknown";
export type ChangeSourceKind = "changelog" | "docs" | "sitemap" | "openapi" | "github_release";
export type SpecChangeKind = "added_required" | "removed" | "renamed" | "type_change" | "enum_removed";

export interface OperationChange { field: string; from?: string; to?: string; kind: SpecChangeKind }
export interface ChangedOperation { method: string; path: string; changes: OperationChange[] }
export interface SpecDiff { addedPaths: string[]; removedPaths: string[]; changedOperations: ChangedOperation[] }

export interface ChangeEntity { type: "resource" | "endpoint" | "param" | "sdk_method" | "package"; name: string }

export interface VendorChange {
  id: string;
  vendor_id: string;
  source: ChangeSourceKind;
  title: string;
  summary: string;
  api_version?: string;
  classification: Classification;
  breaking_confidence: number;
  entities: ChangeEntity[];
  source_urls: string[];
  spec_diff?: SpecDiff;
  raw_excerpt: string;          // max 20_000 chars, truncate on construction
  context_change_id?: string;
  fingerprint: string;
  created_at: string;           // ISO 8601
}

export type Ecosystem = "npm" | "pypi" | "gomod" | "rubygems";
export interface DetectedIntegration {
  vendor_id: string | null;
  ecosystem: Ecosystem;
  package_name: string;
  version?: string;
  evidence: string;             // e.g. "package.json:dependencies"
  confidence: number;           // 0-1
}

export interface Vendor {
  id: string;
  display_name: string;
  kind: "pack" | "generic";
  homepage?: string;
  docs_url?: string;
  changelog_url?: string;
  openapi_url?: string;
  github_repo?: string;         // "owner/name"
  sdk_packages: { ecosystem: Ecosystem; name: string }[];
}

export interface WatchTarget {
  type: "page" | "openapi" | "github_release";
  url?: string;                 // page + openapi
  repo?: string;                // github_release, "owner/name"
  detection?: "exact" | "semantic";
  instructions?: string;        // page semantic
}
export interface Watch { vendor_id: string; targets: WatchTarget[]; status: "active" | "paused" }

export interface SourceState {
  hash?: string;                // sha256 of last-seen spec body
  snapshot?: string;            // last-seen body (openapi) — stored by StateStore, not inline in config
  lastReleaseTag?: string;
  monitorId?: string;           // context.dev
  lastContextChangeId?: string;
  error?: string;
  updated_at: string;
}

export interface ImpactFileHit { path: string; lines: number[]; reason: string }
export type NotPatchableReason = "no_hits" | "unsupported_language" | "generated_client" | "low_confidence";
export interface ImpactReport {
  project_id: string;
  change_id: string;
  files: ImpactFileHit[];
  languages: string[];
  impact_score: number;
  patchable: boolean;
  reason_if_not?: NotPatchableReason;
}

export interface FileEdit { path: string; newContent: string }
export interface HealResult { edits: FileEdit[]; whatChanged: string[]; hasTodos: boolean }

export interface PrInput {
  vendorId: string; fingerprint: string;
  branch: string; title: string; body: string;
  edits: FileEdit[]; labels: string[]; draft: true;
}
export interface IssueInput { title: string; body: string; labels: string[] }

export interface PollResult { state: SourceState; changes: VendorChange[]; skipped?: string }
export interface ChangeSource {
  kind: "openapi" | "github_release" | "page";
  poll(target: WatchTarget, vendor: Vendor, prev: SourceState | null): Promise<PollResult>;
}
export interface RepoAccess {
  listFiles(): Promise<string[]>;        // repo-relative paths, skip-dirs already excluded
  read(path: string): Promise<string>;
}
export interface Publisher {
  openDraftPr(input: PrInput): Promise<{ url: string }>;
  updateDraftPr(branch: string, input: PrInput): Promise<{ url: string }>;
  findOpenAutoshimPr(vendorId: string): Promise<{ branch: string; url: string } | null>;
  openIssue(input: IssueInput): Promise<{ url: string }>;
}
```

```typescript
// ---- fingerprint.ts ----
import { createHash } from "node:crypto";
import type { Classification, ChangeEntity } from "./types.js";

export function fingerprint(vendorId: string, entities: ChangeEntity[], classification: Classification, title: string): string {
  const names = entities.map((e) => e.name).sort().join(",");
  const norm = title.toLowerCase().replace(/\s+/g, " ").trim();
  const h = createHash("sha256").update(`${vendorId}|${names}|${classification}|${norm}`).digest("hex");
  return `sha256:${h}`;
}
export function fp8(fingerprintStr: string): string {
  return fingerprintStr.replace(/^sha256:/, "").slice(0, 8);
}
```

- [ ] **Step 1: Write the failing test** — `packages/core/test/fingerprint.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { fingerprint, fp8 } from "../src/fingerprint.js";

describe("fingerprint", () => {
  const ents = [{ type: "param" as const, name: "charges.source" }, { type: "endpoint" as const, name: "GET /v1/charges" }];
  it("is stable across entity order and title whitespace/case", () => {
    const a = fingerprint("stripe", ents, "breaking", "Removed  Charges Source");
    const b = fingerprint("stripe", [...ents].reverse(), "breaking", "removed charges source");
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it("differs by vendor and classification", () => {
    const a = fingerprint("stripe", ents, "breaking", "t");
    expect(fingerprint("shopify", ents, "breaking", "t")).not.toBe(a);
    expect(fingerprint("stripe", ents, "deprecation", "t")).not.toBe(a);
  });
  it("fp8 gives first 8 hex chars", () => {
    expect(fp8("sha256:abcdef0123456789")).toBe("abcdef01");
  });
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @autoshim/core test` → FAIL (module not found).
- [ ] **Step 3: Implement** `types.ts` + `fingerprint.ts` exactly as above; re-export from `index.ts`: `export * from "./types.js"; export * from "./fingerprint.js";`
- [ ] **Step 4: Run to verify pass** — `pnpm --filter @autoshim/core test` → PASS.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(core): shared types and change fingerprint"`

---

### Task 3: Pack schema, loader, registry + 5 seed packs

**Files:**
- Create: `packages/core/src/packs.ts`
- Create: `packs/_template.yaml`, `packs/stripe.yaml`, `packs/github.yaml`, `packs/openai.yaml`, `packs/shopify.yaml`, `packs/slack.yaml`
- Test: `packages/core/test/packs.test.ts`

**Interfaces:**
- Consumes: `Vendor`, `WatchTarget`, `Ecosystem` from Task 2.
- Produces:
```typescript
export interface Pack {
  id: string;
  display_name: string;
  homepage?: string; docs_url?: string; changelog_url?: string; openapi_url?: string; github_repo?: string;
  packages: Partial<Record<Ecosystem, string[]>>;
  import_patterns: Record<string, string[]>;   // language -> substrings
  watch: WatchTarget[];
  heal?: { languages: string[]; notes?: string };
}
export function parsePack(yamlText: string): Pack;                       // zod-validated, throws on invalid
export function loadPacks(yamlTexts: string[]): PackRegistry;            // throws on duplicate package mapping
export interface PackRegistry {
  byId(id: string): Pack | undefined;
  byPackage(ecosystem: Ecosystem, name: string): Pack | undefined;
  all(): Pack[];
  vendorFor(pack: Pack): Vendor;               // kind: "pack", sdk_packages flattened
}
```

- [ ] **Step 1: Write the failing test** — `packages/core/test/packs.test.ts`:

```typescript
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
});
```

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @autoshim/core test packs` → FAIL.
- [ ] **Step 3: Implement `packs.ts`** — zod schema mirroring `Pack`; `loadPacks` builds two maps (`id`, `${ecosystem}:${name}`), throws `new Error(\`duplicate package mapping: ${key} claimed by ${a} and ${b}\`)` on collision. `vendorFor` copies url fields and flattens `packages` into `sdk_packages`.

- [ ] **Step 4: Write the pack files.** `packs/_template.yaml` (commented guide with every field), then seeds. `packs/stripe.yaml` (this exact content; the other four follow the same shape with the vendor's real URLs):

```yaml
id: stripe
display_name: Stripe
homepage: https://stripe.com
docs_url: https://docs.stripe.com
changelog_url: https://docs.stripe.com/changelog
openapi_url: https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
github_repo: stripe/openapi
packages:
  npm: [stripe]
  pypi: [stripe]
  rubygems: [stripe]
import_patterns:
  javascript: ["require('stripe')", "require(\"stripe\")", "from 'stripe'", "from \"stripe\"", "new Stripe("]
  python: ["import stripe", "from stripe"]
watch:
  - type: openapi
    url: https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
    detection: exact
  - type: github_release
    repo: stripe/openapi
  - type: page
    url: https://docs.stripe.com/changelog
    detection: semantic
    instructions: >
      Alert on new API version sections, deprecations, removals, newly required
      fields, and breaking changes. Ignore navigation, marketing, and cosmetic edits.
heal:
  languages: [javascript, typescript, python]
  notes: "Stripe pins API version via apiVersion in the client constructor; changing behavior often requires bumping apiVersion."
```

Seed data for the other four (use these ids/URLs; fill `import_patterns` analogously):
- `github`: packages npm `[octokit, @octokit/rest]`, pypi `[PyGithub]`; openapi_url `https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json`; github_repo `github/rest-api-description`; changelog `https://github.blog/changelog/`.
- `openai`: packages npm `[openai]`, pypi `[openai]`; openapi_url `https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml`; github_repo `openai/openai-openapi`; changelog `https://platform.openai.com/docs/changelog`.
- `shopify`: packages npm `[@shopify/shopify-api, shopify-api-node]`, pypi `[ShopifyAPI]`; changelog `https://shopify.dev/changelog`; github_repo `Shopify/shopify-api-js`.
- `slack`: packages npm `[@slack/web-api, @slack/bolt]`, pypi `[slack-sdk, slack-bolt]`; changelog `https://docs.slack.dev/changelog`; github_repo `slackapi/node-slack-sdk`.

(Executor: do NOT verify these URLs over the network in tests; they are data. If one is known-stale, fix the YAML.)

- [ ] **Step 5: Run to verify pass**, re-export packs from `index.ts`.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(core): pack schema, registry, 5 seed packs"`

---

### Task 4: Discover — manifest parsers

**Files:**
- Create: `packages/core/src/discover.ts`
- Create fixtures: `fixtures/manifests/js/package.json`, `fixtures/manifests/py/requirements.txt`, `fixtures/manifests/py/pyproject.toml`, `fixtures/manifests/go/go.mod`, `fixtures/manifests/rb/Gemfile.lock`
- Test: `packages/core/test/discover.test.ts`

**Interfaces:**
- Consumes: `DetectedIntegration`, `Ecosystem` (Task 2), `PackRegistry` (Task 3), `RepoAccess` (Task 2).
- Produces:
```typescript
export function parseManifest(filename: string, content: string): DetectedIntegration[]; // vendor_id null, confidence by source kind
export async function discover(repo: RepoAccess, registry: PackRegistry): Promise<DetectedIntegration[]>;
// discover(): finds manifest files among repo.listFiles(), parses each, dedupes by (ecosystem,package),
// resolves vendor_id via registry.byPackage, keeps highest-confidence evidence.
export function detectLanguages(files: string[]): string[]; // ["javascript","typescript","python","go","ruby"] from extensions/manifests
```
Confidence: direct manifest (`package.json` deps, `requirements.txt`, `pyproject.toml`, `go.mod`) = 0.9; lockfile-only (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `poetry.lock`, `Pipfile.lock`, `Gemfile.lock`) = 0.6.

- [ ] **Step 1: Write fixtures.**

`fixtures/manifests/js/package.json`:
```json
{ "name": "sample", "dependencies": { "stripe": "^16.0.0", "klaviyo-api": "^10.0.0" }, "devDependencies": { "vitest": "^3.0.0" } }
```
`fixtures/manifests/py/requirements.txt`:
```
openai>=1.30
requests==2.32.3
# comment line
slack-sdk[optional]>=3.0 ; python_version >= "3.9"
```
`fixtures/manifests/py/pyproject.toml`:
```toml
[project]
name = "sample"
dependencies = ["stripe>=9", "httpx"]

[tool.poetry.dependencies]
python = "^3.11"
ShopifyAPI = "^12.0"
```
`fixtures/manifests/go/go.mod`:
```
module example.com/m

go 1.22

require (
	github.com/stripe/stripe-go/v79 v79.0.0
	github.com/google/uuid v1.6.0
)
```
`fixtures/manifests/rb/Gemfile.lock`:
```
GEM
  remote: https://rubygems.org/
  specs:
    stripe (12.0.0)
    rake (13.2.1)
```

- [ ] **Step 2: Write the failing test** — `packages/core/test/discover.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run to verify fail**, then **Step 4: Implement `discover.ts`.** Parser notes: requirements lines — strip `#` comments, split on `;`, strip `[extras]`, split name at first of `<>=!~ `; pyproject via `smol-toml` (`parse` import), read `project.dependencies` (strings → name prefix) and keys of `tool.poetry.dependencies` minus `python`; go.mod — lines inside `require (...)` or single `require x vY`, first whitespace-token; Gemfile.lock — lines matching `/^    (\S+) \(/` under `specs:`; npm lockfiles — for `package-lock.json` JSON keys of `.packages` (`node_modules/<name>` → name), for `pnpm-lock.yaml` keys of `dependencies`+`devDependencies`? No — lockfile devDeps excluded is not required; keep dependencies only where distinguishable, otherwise include with 0.6 confidence.
- [ ] **Step 5: Run to verify pass**; export from `index.ts`.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(core): integration discovery from manifests"`

---

### Task 5: OpenAPI loader/normalizer

**Files:**
- Create: `packages/core/src/spec/load.ts`
- Test: `packages/core/test/spec-load.test.ts`

**Interfaces:**
- Produces:
```typescript
export interface NormalizedSpec {
  version: string;                                   // info.version or ""
  paths: Record<string, Record<string, unknown>>;    // path -> lowercase method -> operation object
  schemas: Record<string, unknown>;                  // components.schemas (v3) or definitions (v2)
  securitySchemes: Record<string, unknown>;
  raw: unknown;                                      // full parsed doc (for lazy $ref resolution)
}
export function loadSpec(text: string): NormalizedSpec;    // JSON or YAML; throws Error("unparsable spec: ...") otherwise
export function resolveRef(raw: unknown, ref: string): unknown | undefined; // "#/components/schemas/X" walker
```
HTTP methods recognized: get, put, post, delete, patch, options, head, trace. Non-method keys under a path (`parameters`, `$ref`, `summary`) are ignored at the method level.

- [ ] **Step 1: Write the failing test** — `packages/core/test/spec-load.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { loadSpec, resolveRef } from "../src/spec/load.js";

const V3_JSON = JSON.stringify({
  openapi: "3.0.0", info: { title: "t", version: "2024-01-01" },
  paths: { "/v1/charges": { get: { operationId: "listCharges" }, parameters: [] } },
  components: { schemas: { Charge: { type: "object", properties: { id: { type: "string" } } } },
                securitySchemes: { api_key: { type: "http", scheme: "bearer" } } },
});
const V2_YAML = `
swagger: "2.0"
info: { title: t, version: "1.0" }
paths:
  /pets:
    get: { operationId: listPets }
definitions:
  Pet: { type: object }
`;

describe("loadSpec", () => {
  it("parses v3 JSON", () => {
    const s = loadSpec(V3_JSON);
    expect(s.version).toBe("2024-01-01");
    expect(Object.keys(s.paths["/v1/charges"])).toEqual(["get"]);
    expect(s.schemas.Charge).toBeDefined();
    expect(s.securitySchemes.api_key).toBeDefined();
  });
  it("parses swagger 2 YAML, mapping definitions to schemas", () => {
    const s = loadSpec(V2_YAML);
    expect(s.paths["/pets"].get).toBeDefined();
    expect(s.schemas.Pet).toBeDefined();
  });
  it("throws on garbage", () => {
    expect(() => loadSpec("]]not a spec[[")).toThrow(/unparsable/);
  });
  it("throws on parseable non-spec", () => {
    expect(() => loadSpec('{"hello": 1}')).toThrow(/unparsable/);
  });
});

describe("resolveRef", () => {
  it("walks a ref path", () => {
    const raw = JSON.parse(V3_JSON);
    expect(resolveRef(raw, "#/components/schemas/Charge")).toMatchObject({ type: "object" });
    expect(resolveRef(raw, "#/components/schemas/Nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify fail**, **Step 3: implement** (`yaml` package `parse` handles JSON too, but try `JSON.parse` first for the 10MB-spec speed path; a doc is a spec iff it has `paths` and (`openapi` or `swagger`)), **Step 4: verify pass**, export.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(core): openapi/swagger loader and normalizer"`

---

### Task 6: OpenAPI differ + classification (highest-risk component)

**Files:**
- Create: `packages/core/src/spec/diff.ts`, `packages/core/src/spec/classify.ts`
- Create: `fixtures/specs/petstore-a.json`, `fixtures/specs/petstore-b.json`, `scripts/fetch-github-spec-fixture.mjs`
- Test: `packages/core/test/spec-diff.test.ts`, `packages/core/test/spec-diff-github.test.ts`

**Interfaces:**
- Consumes: `NormalizedSpec`, `loadSpec`, `resolveRef` (Task 5); `SpecDiff`, `ChangedOperation`, `OperationChange`, `ChangeEntity`, `Classification` (Task 2).
- Produces:
```typescript
export interface DiffResult {
  specDiff: SpecDiff;
  deprecatedOps: { method: string; path: string }[];  // deprecated:true flips (false/absent -> true)
  addedOperations: { method: string; path: string }[];
  securityChanged: boolean;
}
export function diffSpecs(a: NormalizedSpec, b: NormalizedSpec): DiffResult;
export function classifyDiff(d: DiffResult): { classification: Classification; breaking_confidence: number };
export function diffEntities(d: DiffResult): ChangeEntity[];
```

**Algorithm (implement exactly this; do not full-dereference):**
1. Path sets: `removed = keys(a.paths) - keys(b.paths)`, `added = keys(b.paths) - keys(a.paths)`.
2. Rename detection: for each removed path, find an added path with the identical method set and token-similarity > 0.9 (similarity = 2·|common tokens| / (|tokensA|+|tokensB|), tokens = path split on `/`, `{param}` segments compared as `{}`). Pair → drop from added/removed, emit one `ChangedOperation` per method with `changes:[{field:"path", from:oldPath, to:newPath, kind:"renamed"}]`.
3. Removed path → each of its methods joins `specDiff.removedPaths` (store as `"METHOD path"`, e.g. `"GET /v1/charges"`); same for added → `addedPaths`.
4. Common paths: per method — in a only → removedPaths entry; in b only → addedPaths entry + `addedOperations`. Both: if `JSON.stringify(opA) === JSON.stringify(opB)` skip (fast path). Else compare:
   - `deprecated`: falsy→true = push to `deprecatedOps`.
   - `parameters` (match by `name`+`in`): in a only → `{field:name, kind:"removed"}`; in b only with `required:true` → `{field:name, kind:"added_required"}`; both → compare `schema.type` (or v2 `type`) → `type_change` with from/to; compare `schema.enum`: values present in a but not b → `enum_removed` (from = missing values joined ",").
   - `requestBody` and each `responses[2xx]` content schema: `diffSchema(sa, sb, prefix)` — recursive walk; at `{$ref}` nodes compare ref strings: equal → stop (handled by the components pass), different → resolve both via `resolveRef(raw, ref)` once and recurse. On plain objects: compare `properties` (removed / added-and-in-`required` → added_required / type change), `required` additions for existing props → added_required, `enum` shrink → enum_removed. Depth cap 8; cycle-guard with a `Set` of visited ref pairs.
5. Components pass: for each schema name in both `a.schemas` and `b.schemas`, fast-path stringify compare; if different run `diffSchema` with prefix `<Name>.`; attribute resulting changes to every operation whose stringified body contains the ref string (`#/components/schemas/<Name>` or `#/definitions/<Name>`), grouped into `changedOperations` (one entry per operation, merged with step-4 changes). If it appears in no operation, attach to a synthetic `{method:"", path:"#/components/schemas/<Name>"}` entry.
6. `securityChanged = JSON.stringify(a.securitySchemes) !== JSON.stringify(b.securitySchemes)`.

**classifyDiff rules (PRD §10):** any of removedPaths.length, or any change with kind in {removed, type_change, enum_removed, added_required}, or securityChanged → `{breaking, 0.95}`. Else deprecatedOps.length → `{deprecation, 0.7}`. Else addedPaths/addedOperations length → `{additive, 0.5}`. Else `{docs_only, 0.9}`.

**diffEntities:** endpoints from removedPaths + renamed pairs + changedOperations (`"GET /v1/x"` form, type "endpoint"); params from every OperationChange field (type "param"); resources from `<Name>.` prefixed fields' first segment (type "resource"). Dedupe by (type,name).

- [ ] **Step 1: Write handcrafted fixtures.** `fixtures/specs/petstore-a.json`:

```json
{
  "openapi": "3.0.0",
  "info": { "title": "petstore", "version": "1.0.0" },
  "paths": {
    "/v1/pets": {
      "get": { "operationId": "listPets", "parameters": [ { "name": "limit", "in": "query", "schema": { "type": "integer" } } ],
               "responses": { "200": { "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Pet" } } } } } },
      "post": { "operationId": "createPet",
                "requestBody": { "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Pet" } } } } }
    },
    "/v1/pets/{id}": { "get": { "operationId": "getPet" } },
    "/v1/stores": { "get": { "operationId": "listStores" } }
  },
  "components": { "schemas": {
    "Pet": { "type": "object", "required": ["name"],
             "properties": { "name": { "type": "string" }, "tag": { "type": "string" },
                             "status": { "type": "string", "enum": ["available", "sold", "pending"] } } } } }
}
```

`fixtures/specs/petstore-b.json` — same doc with these five mutations: (1) `Pet.properties.tag` deleted; (2) `Pet.properties.status.enum` = `["available","sold"]`; (3) `/v1/stores` deleted; (4) new path `/v1/orders` with a `get`; (5) `/v1/pets get` parameter `limit` schema type `integer` → `string`, and `deprecated: true` added on `/v1/pets/{id} get`.

- [ ] **Step 2: Write the failing tests** — `packages/core/test/spec-diff.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSpec } from "../src/spec/load.js";
import { diffSpecs, classifyDiff, diffEntities } from "../src/spec/diff.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const spec = (f: string) => loadSpec(readFileSync(join(root, "fixtures/specs", f), "utf8"));

describe("diffSpecs on petstore pair", () => {
  const d = diffSpecs(spec("petstore-a.json"), spec("petstore-b.json"));
  it("finds removed and added paths", () => {
    expect(d.specDiff.removedPaths).toContain("GET /v1/stores");
    expect(d.specDiff.addedPaths).toContain("GET /v1/orders");
  });
  it("finds property removal via $ref into components (both get and post on /v1/pets)", () => {
    const pets = d.specDiff.changedOperations.filter((o) => o.path === "/v1/pets");
    expect(pets.length).toBeGreaterThanOrEqual(2);
    const kinds = pets.flatMap((o) => o.changes).map((c) => `${c.field}:${c.kind}`);
    expect(kinds).toContain("Pet.tag:removed");
    expect(kinds).toContain("Pet.status:enum_removed");
  });
  it("finds param type change with from/to", () => {
    const get = d.specDiff.changedOperations.find((o) => o.path === "/v1/pets" && o.method === "get")!;
    const tc = get.changes.find((c) => c.kind === "type_change")!;
    expect(tc.field).toBe("limit");
    expect(tc.from).toBe("integer");
    expect(tc.to).toBe("string");
  });
  it("finds deprecation flip", () => {
    expect(d.deprecatedOps).toContainEqual({ method: "get", path: "/v1/pets/{id}" });
  });
  it("classifies as breaking at 0.95", () => {
    expect(classifyDiff(d)).toEqual({ classification: "breaking", breaking_confidence: 0.95 });
  });
  it("derives entities", () => {
    const ents = diffEntities(d);
    expect(ents).toContainEqual({ type: "endpoint", name: "GET /v1/stores" });
    expect(ents).toContainEqual({ type: "resource", name: "Pet" });
    expect(ents).toContainEqual({ type: "param", name: "limit" });
  });
});

describe("classification tiers", () => {
  it("identical specs -> docs_only; additive-only -> additive; deprecation-only -> deprecation", () => {
    const a = spec("petstore-a.json");
    expect(classifyDiff(diffSpecs(a, a)).classification).toBe("docs_only");
    const bAdd = structuredClone(a); (bAdd.paths as any)["/v1/new"] = { get: {} };
    expect(classifyDiff(diffSpecs(a, bAdd)).classification).toBe("additive");
    const bDep = structuredClone(a); (bDep.paths as any)["/v1/pets"].get.deprecated = true;
    expect(classifyDiff(diffSpecs(a, bDep)).classification).toBe("deprecation");
  });
  it("rename is detected, not removed+added", () => {
    const a = spec("petstore-a.json");
    const b = structuredClone(a);
    (b.paths as any)["/v1/pets_list"] = (b.paths as any)["/v1/pets"];
    delete (b.paths as any)["/v1/pets"];
    const d = diffSpecs(a, b);
    expect(d.specDiff.removedPaths).not.toContain("GET /v1/pets");
    const renamed = d.specDiff.changedOperations.flatMap((o) => o.changes).find((c) => c.kind === "renamed");
    expect(renamed).toMatchObject({ from: "/v1/pets", to: "/v1/pets_list" });
  });
});
```

`packages/core/test/spec-diff-github.test.ts` (perf/sanity; net-gated):
```typescript
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
```

`scripts/fetch-github-spec-fixture.mjs` — downloads two pinned revisions into the gitignored `fixtures/specs/downloaded/` (run manually / by the executor once, never by CI):
```javascript
// Usage: node scripts/fetch-github-spec-fixture.mjs
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
const dir = "fixtures/specs/downloaded";
mkdirSync(dir, { recursive: true });
const FILE = "descriptions/api.github.com/api.github.com.json";
// two commits ~6 months apart; any pair works — pin whatever `git log` on the repo shows at execution time
const revs = { "github-a.json": "heads/main~200", "github-b.json": "heads/main" };
for (const [out, rev] of Object.entries(revs)) {
  const p = `${dir}/${out}`;
  if (existsSync(p)) continue;
  const url = `https://raw.githubusercontent.com/github/rest-api-description/${rev}/${FILE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  writeFileSync(p, await res.text());
  console.log("fetched", p);
}
```
(Executor note: raw.githubusercontent does not resolve `~N` relative revs — resolve two concrete SHAs first via `https://api.github.com/repos/github/rest-api-description/commits?path=${FILE}&per_page=100`, take the newest and the ~100th, and substitute them. Adjust the script accordingly when implementing.)

**AMENDMENTS (2026-09-01, post code-study — these override any contradicting text above; see `docs/research/2026-09-01-code-study.md`):**
1. **No rename detection in v1.** Delete algorithm step 2 and the "rename is detected" test; a removed+added path pair is reported as removal + addition (matching oasdiff/libopenapi). The `renamed` SpecChangeKind stays in the type, unemitted.
2. **Stable rule ids.** Add optional `rule?: string` to `OperationChange` (additive change to Task 2's type — coordinate: it is optional, so no ripple). Every emitted change carries a kebab-case id, e.g. `request-parameter-became-required`, `response-property-removed`, `request-parameter-type-changed`, `request-enum-value-removed`, `response-enum-value-added`, `operation-removed`, `operation-deprecated`, `security-scheme-changed`.
3. **Direction-aware classification with guards.** Request vs response polarity applies: property/param removal or requiredness in REQUESTS breaks; property removal in RESPONSES breaks; enum value REMOVED from request breaks, enum value ADDED to response breaks; a `readOnly: true` property is exempt from request-side rules, `writeOnly: true` exempt from response-side rules; response media-type removal breaks (negotiated field); changes confined to non-2xx responses are downgraded to additive/docs_only.
4. **Normalization pass in the loader/differ boundary:** flatten `allOf` into a synthesized schema before diffing, and normalize OpenAPI 3.1 `type: [X, "null"]` to 3.0-style `nullable` so the two conventions never diff against each other.
5. **Cycle + memo discipline:** visited-set of `$ref` names per traversal side (circular refs equal iff same ref name); memoize schema-pair comparisons keyed by (refA, refB, direction).
6. Tests to add for the amendments: readOnly-required-property added → NOT breaking; enum value added to response schema → breaking with rule `response-enum-value-added`; 3.1 nullable-array vs 3.0 nullable → no diff; removal confined to a 404 response → not breaking.

- [ ] **Step 3: Run to verify fail**, **Step 4: implement `diff.ts` + `classify.ts` per the algorithm above** (keep `diffSchema` its own function; fast-path stringify compares before any recursion), **Step 5: verify petstore tests pass**, **Step 6:** run `node scripts/fetch-github-spec-fixture.mjs && AUTOSHIM_NET_TESTS=1 pnpm --filter @autoshim/core test spec-diff-github` and make the perf bar; export new modules from `index.ts`.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(core): openapi structural differ with classification"`

---

### Task 7: openapi ChangeSource + simulate

**Files:**
- Create: `packages/core/src/sources/openapi.ts`
- Test: `packages/core/test/source-openapi.test.ts`

**Interfaces:**
- Consumes: `ChangeSource`, `WatchTarget`, `Vendor`, `SourceState`, `PollResult`, `VendorChange` (Task 2); `loadSpec` (5); `diffSpecs`, `classifyDiff`, `diffEntities` (6); `fingerprint` (2).
- Produces:
```typescript
export interface OpenApiSourceOpts { fetchFn?: typeof fetch; now?: () => Date; idFn?: () => string }
export function openApiSource(opts?: OpenApiSourceOpts): ChangeSource;   // kind: "openapi"
export function specBodyToChange(vendor: Vendor, url: string, prevBody: string, nextBody: string, now: Date, id: string): VendorChange | null;
// null when classification is docs_only AND the diff is empty (byte change with no semantic change)
```
Behavior of `poll(target, vendor, prev)`:
- Resolve body: `target.url` starting with `http` → `fetchFn(url)` (non-2xx → `{state:{...prev,error:"http 404",updated_at},changes:[]}`); otherwise treat as local file path and read with `node:fs/promises` `readFile` (this is what `simulate` and tests use).
- sha256 the body. `prev == null` → seed: `{state:{hash,snapshot:body,updated_at},changes:[]}`.
- hash unchanged → `{state:prev-with-fresh-updated_at, changes:[]}`.
- changed → `specBodyToChange(vendor, url, prev.snapshot!, body, ...)`; VendorChange fields: `source:"openapi"`, `title` = \`{display_name} OpenAPI spec changed ({n} breaking/N changes)\` — deterministic from the DiffResult, `summary` = first 10 diff lines rendered as text, `api_version` = next spec `info.version`, `spec_diff`, `raw_excerpt` = JSON.stringify(specDiff).slice(0, 20000), `source_urls:[url]`, `id` = \`chg_${fp8(fingerprint)}\`. New state keeps new hash+snapshot.
- If `loadSpec` throws on either side → state.error = `unparsable: <msg>`, no change (spec §9).

- [ ] **Step 1: Write the failing test** — `packages/core/test/source-openapi.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openApiSource } from "../src/sources/openapi.js";
import type { Vendor } from "../src/types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const petA = readFileSync(join(root, "fixtures/specs/petstore-a.json"), "utf8");
const petB = readFileSync(join(root, "fixtures/specs/petstore-b.json"), "utf8");
const vendor: Vendor = { id: "pets", display_name: "Pets", kind: "generic", sdk_packages: [] };
const now = () => new Date("2026-09-01T00:00:00Z");

describe("openApiSource with local files", () => {
  it("seeds on first poll, emits nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "as-"));
    const f = join(dir, "spec.json");
    writeFileSync(f, petA);
    const src = openApiSource({ now });
    const r = await src.poll({ type: "openapi", url: f }, vendor, null);
    expect(r.changes).toEqual([]);
    expect(r.state.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.state.snapshot).toBe(petA);
  });
  it("no change on same content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "as-"));
    const f = join(dir, "spec.json");
    writeFileSync(f, petA);
    const src = openApiSource({ now });
    const seed = await src.poll({ type: "openapi", url: f }, vendor, null);
    const r2 = await src.poll({ type: "openapi", url: f }, vendor, seed.state);
    expect(r2.changes).toEqual([]);
  });
  it("emits one breaking VendorChange on mutation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "as-"));
    const f = join(dir, "spec.json");
    writeFileSync(f, petA);
    const src = openApiSource({ now });
    const seed = await src.poll({ type: "openapi", url: f }, vendor, null);
    writeFileSync(f, petB);
    const r = await src.poll({ type: "openapi", url: f }, vendor, seed.state);
    expect(r.changes).toHaveLength(1);
    const c = r.changes[0];
    expect(c.classification).toBe("breaking");
    expect(c.source).toBe("openapi");
    expect(c.spec_diff!.removedPaths).toContain("GET /v1/stores");
    expect(c.fingerprint).toMatch(/^sha256:/);
    expect(c.id).toBe(`chg_${c.fingerprint.slice(7, 15)}`);
    expect(r.state.snapshot).toBe(petB);
  });
  it("marks unparsable without emitting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "as-"));
    const f = join(dir, "spec.json");
    writeFileSync(f, petA);
    const src = openApiSource({ now });
    const seed = await src.poll({ type: "openapi", url: f }, vendor, null);
    writeFileSync(f, "%% nope %%");
    const r = await src.poll({ type: "openapi", url: f }, vendor, seed.state);
    expect(r.changes).toEqual([]);
    expect(r.state.error).toMatch(/unparsable/);
  });
});

describe("openApiSource over http", () => {
  it("uses injected fetch and records http errors", async () => {
    const src = openApiSource({ now, fetchFn: (async () => new Response("x", { status: 404 })) as typeof fetch });
    const r = await src.poll({ type: "openapi", url: "https://api.example.com/openapi.json" }, vendor, null);
    expect(r.changes).toEqual([]);
    expect(r.state.error).toMatch(/404/);
  });
});
```

- [ ] **Step 2: Run to verify fail**, **Step 3: implement**, **Step 4: verify pass**, export from index.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(core): openapi change source with local snapshot diffing"`

---

### Task 8: LlmExtractor (Claude) + release-notes classification

**Files:**
- Create: `packages/core/src/extract.ts`
- Test: `packages/core/test/extract.test.ts`

**Interfaces:**
- Consumes: `VendorChange`, `Classification`, `ChangeEntity`, `Vendor` (2); `fingerprint`, `fp8` (2).
- Produces:
```typescript
// PRD §9 generic extract schema, as zod:
export const ExtractItem = z.object({
  title: z.string(),
  date: z.string().optional(),
  impact: z.enum(["additive", "breaking", "deprecation", "docs_only", "unknown"]),
  resources: z.array(z.string()).optional(),
  endpoints: z.array(z.string()).optional(),
  params: z.array(z.string()).optional(),
  urls: z.array(z.string()).optional(),
  notes: z.string().optional(),
});
export const ExtractResult = z.object({
  product: z.string().optional(),
  api_version: z.string().optional(),
  items: z.array(ExtractItem),
});
export type ExtractResultT = z.infer<typeof ExtractResult>;
export interface LlmExtractor { extract(text: string, hint: string): Promise<ExtractResultT> }
export function claudeExtractor(client?: Anthropic): LlmExtractor;   // real impl, constructed lazily; throws Error("needs ANTHROPIC_API_KEY") from extract() when no key
export function itemsToChanges(vendor: Vendor, source: "github_release" | "changelog", items: ExtractResultT, sourceUrl: string, rawExcerpt: string, now: Date): VendorChange[];
// one VendorChange per item with impact !== "docs_only"; classification = impact;
// confidence: breaking 0.8, deprecation 0.7, additive 0.5, unknown 0.3;
// entities from resources (resource) + endpoints (endpoint) + params (param); raw_excerpt truncated to 20k.
```
`claudeExtractor` implementation (pinned shapes — Global Constraints):
```typescript
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
// inside extract():
const response = await client.messages.parse({
  model: "claude-opus-5",
  max_tokens: 16000,
  system: "You extract API-change items from vendor release notes or changelog text. Report only what the text states; when unsure of impact use \"unknown\". Never invent endpoints.",
  messages: [{ role: "user", content: `${hint}\n\n<text>\n${text.slice(0, 100_000)}\n</text>` }],
  output_config: { format: zodOutputFormat(ExtractResult) },
});
if (!response.parsed_output) throw new Error("extract: unparsable model output");
return response.parsed_output;
```

- [ ] **Step 1: Write the failing test** — `packages/core/test/extract.test.ts` (tests `itemsToChanges` + a FakeExtractor; the Claude impl is exercised only for its no-key error):

```typescript
import { describe, it, expect } from "vitest";
import { itemsToChanges, claudeExtractor, type ExtractResultT } from "../src/extract.js";
import type { Vendor } from "../src/types.js";

const vendor: Vendor = { id: "acme", display_name: "Acme", kind: "generic", sdk_packages: [] };
const now = new Date("2026-09-01T00:00:00Z");
const items: ExtractResultT = {
  api_version: "2026-09",
  items: [
    { title: "Removed charges.source", impact: "breaking", params: ["charges.source"], endpoints: ["POST /v1/charges"] },
    { title: "Docs typo fix", impact: "docs_only" },
    { title: "New field balance", impact: "additive", params: ["balance"] },
  ],
};

describe("itemsToChanges", () => {
  const out = itemsToChanges(vendor, "github_release", items, "https://x/rel/1", "raw body", now);
  it("drops docs_only, keeps others", () => {
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.classification)).toEqual(["breaking", "additive"]);
  });
  it("maps entities and confidence", () => {
    expect(out[0].entities).toContainEqual({ type: "param", name: "charges.source" });
    expect(out[0].entities).toContainEqual({ type: "endpoint", name: "POST /v1/charges" });
    expect(out[0].breaking_confidence).toBe(0.8);
    expect(out[1].breaking_confidence).toBe(0.5);
  });
  it("carries source url, api_version, fingerprint id", () => {
    expect(out[0].source_urls).toEqual(["https://x/rel/1"]);
    expect(out[0].api_version).toBe("2026-09");
    expect(out[0].id).toBe(`chg_${out[0].fingerprint.slice(7, 15)}`);
  });
  it("truncates raw_excerpt to 20k", () => {
    const big = itemsToChanges(vendor, "changelog", items, "u", "x".repeat(30000), now);
    expect(big[0].raw_excerpt.length).toBe(20000);
  });
});

describe("claudeExtractor without key", () => {
  it("throws needs-key from extract(), not from construction", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const ex = claudeExtractor();
    await expect(ex.extract("t", "h")).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
```

- [ ] **Step 2: Run to verify fail**, **Step 3: implement** (`claudeExtractor()` checks `process.env.ANTHROPIC_API_KEY` inside `extract` before constructing the client), **Step 4: verify pass**, export.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(core): claude extractor and release-note classification"`

---

### Task 9: github_release ChangeSource

**Files:**
- Create: `packages/core/src/sources/githubRelease.ts`
- Test: `packages/core/test/source-github.test.ts`

**Interfaces:**
- Consumes: `ChangeSource`, `PollResult`, `Vendor`, `SourceState` (2); `LlmExtractor`, `itemsToChanges` (8).
- Produces:
```typescript
export function githubReleaseSource(extractor: LlmExtractor, opts?: { fetchFn?: typeof fetch; now?: () => Date }): ChangeSource; // kind "github_release"
```
Behavior of `poll({repo}, vendor, prev)`:
- `GET https://api.github.com/repos/{repo}/releases?per_page=10`, headers `{"Accept":"application/vnd.github+json","User-Agent":"autoshim"}` plus `Authorization: Bearer $GITHUB_TOKEN` when set. Non-2xx → state.error, no changes.
- Releases newer than `prev.lastReleaseTag` (releases arrive newest-first; take until the known tag is seen). `prev == null` → seed `lastReleaseTag` to newest, emit nothing.
- For each new release: `extractor.extract(release.body ?? release.name, hint)` with hint \`Vendor: {display_name}. Source: GitHub release {tag_name}.\` → `itemsToChanges(vendor, "github_release", ..., release.html_url, release.body, now)`. Extractor throwing needs-key → `{state: prev-with-updated_at, changes: [], skipped: "needs ANTHROPIC_API_KEY"}` (spec §9: report skipped, don't throw; don't advance lastReleaseTag so the release is retried once a key exists).

- [ ] **Step 1: Write the failing test** — `packages/core/test/source-github.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { githubReleaseSource } from "../src/sources/githubRelease.js";
import type { LlmExtractor, ExtractResultT } from "../src/extract.js";
import type { Vendor } from "../src/types.js";

const vendor: Vendor = { id: "stripe", display_name: "Stripe", kind: "pack", sdk_packages: [] };
const now = () => new Date("2026-09-01T00:00:00Z");
const releases = [
  { tag_name: "v2", name: "v2", body: "BREAKING: removed setTimeout", html_url: "https://gh/rel/v2" },
  { tag_name: "v1", name: "v1", body: "initial", html_url: "https://gh/rel/v1" },
];
const fetchFn = (async (url: RequestInfo | URL) => {
  expect(String(url)).toContain("/repos/stripe/openapi/releases");
  return new Response(JSON.stringify(releases), { status: 200 });
}) as typeof fetch;
const fake = (result: ExtractResultT): LlmExtractor => ({ extract: async () => result });
const oneBreaking: ExtractResultT = { items: [{ title: "removed setTimeout", impact: "breaking", params: ["setTimeout"] }] };

describe("githubReleaseSource", () => {
  const target = { type: "github_release" as const, repo: "stripe/openapi" };
  it("seeds to newest tag without emitting", async () => {
    const src = githubReleaseSource(fake(oneBreaking), { fetchFn, now });
    const r = await src.poll(target, vendor, null);
    expect(r.changes).toEqual([]);
    expect(r.state.lastReleaseTag).toBe("v2");
  });
  it("emits changes for releases newer than lastReleaseTag", async () => {
    const src = githubReleaseSource(fake(oneBreaking), { fetchFn, now });
    const r = await src.poll(target, vendor, { lastReleaseTag: "v1", updated_at: "x" });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].source).toBe("github_release");
    expect(r.changes[0].source_urls).toEqual(["https://gh/rel/v2"]);
    expect(r.state.lastReleaseTag).toBe("v2");
  });
  it("reports skipped and holds position when extractor needs a key", async () => {
    const needy: LlmExtractor = { extract: async () => { throw new Error("needs ANTHROPIC_API_KEY"); } };
    const src = githubReleaseSource(needy, { fetchFn, now });
    const r = await src.poll(target, vendor, { lastReleaseTag: "v1", updated_at: "x" });
    expect(r.changes).toEqual([]);
    expect(r.skipped).toMatch(/ANTHROPIC_API_KEY/);
    expect(r.state.lastReleaseTag).toBe("v1");
  });
  it("records http errors", async () => {
    const bad = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const src = githubReleaseSource(fake(oneBreaking), { fetchFn: bad, now });
    const r = await src.poll(target, vendor, null);
    expect(r.state.error).toMatch(/500/);
  });
});
```

- [ ] **Step 2: fail**, **Step 3: implement**, **Step 4: pass**, export.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(core): github releases change source"`

---

### Task 10: Context.dev page ChangeSource

**Files:**
- Create: `packages/core/src/sources/contextDev.ts` (ALL Context.dev HTTP lives in this one file)
- Test: `packages/core/test/source-contextdev.test.ts`

**Interfaces:**
- Consumes: `ChangeSource`, `PollResult` (2); `LlmExtractor`, `itemsToChanges` (8).
- Produces:
```typescript
export function contextDevSource(extractor: LlmExtractor, opts?: { fetchFn?: typeof fetch; now?: () => Date; apiKey?: string }): ChangeSource; // kind "page"
```
Endpoint shapes (Global Constraints: create/list verified; changes/extract doc-inferred — **Step 0** below re-verifies):
- Create: `POST https://api.context.dev/v1/monitors` body `{ name, target: { type: "page", url, instructions? }, change_detection: { type: target.detection ?? "exact", ...(semantic ? { confidence_threshold: 0.75 } : {}) }, schedule: { type: "interval", frequency: 6, unit: "hours" }, tags: ["autoshim", vendor.id] }` → response `{ id, ... }`.
- Poll: `GET https://api.context.dev/v1/monitors/{id}/changes` → `{ changes: [{ id, summary?, diff?, detected_at, ... }] }` (defensive parse: accept an array at top level too).
Behavior of `poll(target, vendor, prev)`:
1. No `apiKey` (default `process.env.CONTEXT_API_KEY`) → `{ state: prev ?? {updated_at}, changes: [], skipped: "needs CONTEXT_API_KEY" }`.
2. `prev?.monitorId` absent → create monitor (name \`autoshim:{vendor.id}:{url}\`), store `monitorId`, emit nothing (baseline run).
3. Else GET changes; keep those with id lexicographically/positionally after `prev.lastContextChangeId` (store newest id back). For each: text = `summary ?? diff ?? JSON.stringify(change)`; run `extractor.extract(text, hint)` → `itemsToChanges(vendor, "changelog", ..., target.url!, text, now)`. Extractor needs-key → skipped like Task 9, don't advance `lastContextChangeId`.
4. Any non-2xx → state.error with status, no changes.

- [ ] **Step 0 (execution-time verification, no test):** if `CONTEXT_API_KEY` is set in the executor's environment, `curl -s -H "Authorization: Bearer $CONTEXT_API_KEY" https://api.context.dev/v1/monitors | head -c 400` and (if any monitor exists) `GET /v1/monitors/{id}/changes`; adjust the response-parsing lines in `contextDev.ts` to the observed shape. If no key: trust the doc shape above and note it in the commit message.

- [ ] **Step 1: Write the failing test** — `packages/core/test/source-contextdev.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { contextDevSource } from "../src/sources/contextDev.js";
import type { LlmExtractor, ExtractResultT } from "../src/extract.js";
import type { Vendor } from "../src/types.js";

const vendor: Vendor = { id: "acme", display_name: "Acme", kind: "generic", sdk_packages: [] };
const now = () => new Date("2026-09-01T00:00:00Z");
const target = { type: "page" as const, url: "https://acme.com/changelog", detection: "semantic" as const, instructions: "alert on breaking changes" };
const fake: LlmExtractor = { extract: async () => ({ items: [{ title: "Removed X", impact: "breaking" as const }] }) };

function fakeApi(calls: { method: string; url: string; body?: any }[]) {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ method: init?.method ?? "GET", url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (u.endsWith("/v1/monitors") && init?.method === "POST") return new Response(JSON.stringify({ id: "mon_1" }), { status: 200 });
    if (u.includes("/v1/monitors/mon_1/changes")) return new Response(JSON.stringify({ changes: [{ id: "chg_b", summary: "Removed X endpoint" }, { id: "chg_a", summary: "older" }] }), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("contextDevSource", () => {
  it("skips without key", async () => {
    const src = contextDevSource(fake, { now, apiKey: undefined, fetchFn: fakeApi([]) });
    const r = await src.poll(target, vendor, null);
    expect(r.skipped).toMatch(/CONTEXT_API_KEY/);
    expect(r.changes).toEqual([]);
  });
  it("creates a monitor idempotently on first poll (no emit) with auth header", async () => {
    const calls: any[] = [];
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer ctxt_secret_test");
      return fakeApi(calls)(url, init);
    }) as typeof fetch;
    const src = contextDevSource(fake, { now, apiKey: "ctxt_secret_test", fetchFn });
    const r = await src.poll(target, vendor, null);
    expect(r.changes).toEqual([]);
    expect(r.state.monitorId).toBe("mon_1");
    expect(calls[0].body.target).toMatchObject({ type: "page", url: target.url });
    expect(calls[0].body.change_detection.type).toBe("semantic");
  });
  it("polls changes after monitor exists and emits via extractor", async () => {
    const src = contextDevSource(fake, { now, apiKey: "k", fetchFn: fakeApi([]) });
    const r = await src.poll(target, vendor, { monitorId: "mon_1", lastContextChangeId: "chg_a", updated_at: "x" });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].classification).toBe("breaking");
    expect(r.changes[0].source).toBe("changelog");
    expect(r.state.lastContextChangeId).toBe("chg_b");
  });
});
```

- [ ] **Step 2: fail**, **Step 3: implement**, **Step 4: pass**, export.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(core): context.dev page monitor change source"`

---

### Task 11: Impact scan

**Files:**
- Create: `packages/core/src/impact.ts`
- Create fixture repos:
  - `fixtures/repos/js-stripe/package.json`, `fixtures/repos/js-stripe/src/pay.ts`, `fixtures/repos/js-stripe/src/other.ts`
  - `fixtures/repos/py-openai/requirements.txt`, `fixtures/repos/py-openai/app/embed.py`
- Test: `packages/core/test/impact.test.ts`

**Interfaces:**
- Consumes: `RepoAccess`, `VendorChange`, `ImpactReport`, `ImpactFileHit`, `Vendor` (2); `Pack` (3); `detectLanguages` (4).
- Produces:
```typescript
export interface FileIndexEntry { path: string; language: string; imports: string[]; content: string }
export async function buildIndex(repo: RepoAccess): Promise<FileIndexEntry[]>;
// only .js .jsx .ts .tsx .mjs .cjs .py files; language from extension; imports = matched require/import/from module names
export function scanImpact(index: FileIndexEntry[], change: VendorChange, vendor: Vendor, pack: Pack | undefined, projectId: string): ImpactReport;
```
Scoring (PRD §12.2): `impact_score = 3*spec_symbol_hits + 2*sdk_import_files + 1*string_path_hits`.
- spec_symbol_hits: lines containing an entity name (param/resource names, and the path part of endpoint entities like `/v1/charges`) — count per matching line; reason `"entity: <name>"`.
- sdk_import_files: files whose imports include any `vendor.sdk_packages` name, or whose content contains any pack `import_patterns` string for its language family (javascript patterns apply to ts/js) — 1 per file; reason `"sdk import: <pkg>"`.
- string_path_hits: lines whose string literals contain a `spec_diff` removed/changed path (`"GET /v1/x"` → search `/v1/x`) or a vendor API hostname derived from `vendor.homepage`; reason `"path string: <p>"`.
Patchable (PRD §12.3): `files.length >= 1 && languages ⊆ {javascript,typescript,python} (at least one hit file in those) && change.classification !== "docs_only" && (change.breaking_confidence >= 0.55 || change.spec_diff != null)`. `reason_if_not`: `"no_hits"` / `"unsupported_language"` / `"low_confidence"` in that precedence.

- [ ] **Step 1: Write fixture repos.** `fixtures/repos/js-stripe/src/pay.ts`:
```typescript
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_KEY!);
export async function charge(sourceId: string) {
  return fetch("https://api.stripe.com/v1/charges", { method: "POST", body: JSON.stringify({ source: sourceId }) });
}
```
`src/other.ts`: `export const nothing = 1;`. `package.json`: `{ "dependencies": { "stripe": "^16.0.0" } }`.
`fixtures/repos/py-openai/app/embed.py`:
```python
import openai
client = openai.OpenAI()
def embed(text):
    return client.embeddings.create(model="text-embedding-3-small", input=text)
```

- [ ] **Step 2: Write the failing test** — `packages/core/test/impact.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, scanImpact } from "../src/impact.js";
import type { RepoAccess, VendorChange, Vendor } from "../src/types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
function fsRepo(dir: string): RepoAccess {
  const base = join(root, "fixtures/repos", dir);
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [relative(base, p)];
  });
  return { listFiles: async () => walk(base), read: async (p) => readFileSync(join(base, p), "utf8") };
}
const stripeVendor: Vendor = { id: "stripe", display_name: "Stripe", kind: "pack", homepage: "https://stripe.com", sdk_packages: [{ ecosystem: "npm", name: "stripe" }] };
const change: VendorChange = {
  id: "chg_1", vendor_id: "stripe", source: "openapi", title: "removed source", summary: "",
  classification: "breaking", breaking_confidence: 0.95,
  entities: [{ type: "param", name: "source" }, { type: "endpoint", name: "POST /v1/charges" }],
  source_urls: [], raw_excerpt: "",
  spec_diff: { addedPaths: [], removedPaths: [], changedOperations: [{ method: "post", path: "/v1/charges", changes: [{ field: "source", kind: "removed" }] }] },
  fingerprint: "sha256:" + "ab".repeat(32), created_at: "2026-09-01T00:00:00Z",
};

describe("impact scan on js-stripe fixture", () => {
  it("hits pay.ts via import, entity, and path string; skips other.ts", async () => {
    const idx = await buildIndex(fsRepo("js-stripe"));
    const r = scanImpact(idx, change, stripeVendor, undefined, "proj");
    expect(r.files.map((f) => f.path)).toEqual(["src/pay.ts"]);
    expect(r.files[0].lines.length).toBeGreaterThan(0);
    expect(r.impact_score).toBeGreaterThanOrEqual(3 + 2 + 1);
    expect(r.patchable).toBe(true);
    expect(r.languages).toContain("typescript");
  });
  it("no hits -> not patchable with reason no_hits", async () => {
    const idx = await buildIndex(fsRepo("py-openai"));
    const r = scanImpact(idx, change, stripeVendor, undefined, "proj");
    expect(r.files).toEqual([]);
    expect(r.patchable).toBe(false);
    expect(r.reason_if_not).toBe("no_hits");
  });
  it("low confidence without spec_diff -> not patchable", async () => {
    const idx = await buildIndex(fsRepo("js-stripe"));
    const weak = { ...change, spec_diff: undefined, breaking_confidence: 0.3 };
    const r = scanImpact(idx, weak, stripeVendor, undefined, "proj");
    expect(r.patchable).toBe(false);
    expect(r.reason_if_not).toBe("low_confidence");
  });
});

describe("buildIndex", () => {
  it("indexes only code files with imports", async () => {
    const idx = await buildIndex(fsRepo("js-stripe"));
    expect(idx.map((e) => e.path).sort()).toEqual(["src/other.ts", "src/pay.ts"]);
    expect(idx.find((e) => e.path === "src/pay.ts")!.imports).toContain("stripe");
  });
});
```

- [ ] **Step 3: fail**, **Step 4: implement `impact.ts`** (import regexes: `/import\s+.*?from\s+["']([^"']+)["']/g`, `/require\(\s*["']([^"']+)["']\s*\)/g`, python `/^\s*(?:import|from)\s+([A-Za-z0-9_\.]+)/gm`; generic entity names shorter than 4 chars are only matched as whole words to avoid noise), **Step 5: pass**, export.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(core): impact index and scoring"`

---

### Task 12: Healer (constrained agent pass)

**Files:**
- Create: `packages/core/src/heal.ts`
- Test: `packages/core/test/heal.test.ts`

**Interfaces:**
- Consumes: `VendorChange`, `ImpactReport`, `FileEdit`, `HealResult`, `RepoAccess` (2); `Pack` (3).
- Produces:
```typescript
export const HealOutput = z.object({
  edits: z.array(z.object({ path: z.string(), newContent: z.string() })),
  what_changed: z.array(z.string()),
});
export interface HealAgent { run(systemPrompt: string, userPayload: string): Promise<z.infer<typeof HealOutput>> }
export function claudeHealAgent(): HealAgent;  // streaming; throws Error("needs ANTHROPIC_API_KEY") from run() when unset
export const HEAL_SYSTEM_PROMPT: string;       // contains, verbatim: "Draft PR only", "No lockfile bumps unless required to compile", "No refactors", "No new dependencies", "If unsure, add // TODO(autoshim): verify", "Include test edits only if existing tests assert old field names"
export interface HealCaps { maxFiles: number; maxChangedLines: number }   // defaults { 20, 400 }
export type HealOutcome =
  | { ok: true; result: HealResult; changedLines: number }
  | { ok: false; reason: string; attempted?: FileEdit[] };
export async function heal(agent: HealAgent, repo: RepoAccess, change: VendorChange, impact: ImpactReport, pack: Pack | undefined, caps?: HealCaps): Promise<HealOutcome>;
```
`heal()` behavior: build user payload JSON `{ change (without raw_excerpt beyond 4k), impact.files, fileContents: {path: content} for hit files only, packNotes }`; call agent; then enforce:
- every edit path ∈ hit files, allowing at most ONE extra path not in hit files (import fix) — more → `{ok:false, reason:"edits outside allowed files", attempted}`;
- edits.length ≤ maxFiles;
- changedLines = Σ per-file added+removed lines via `diffLines` from `diff` package comparing old repo content to `newContent`; > maxChangedLines → `{ok:false, reason:"diff too large (N lines)", attempted}`;
- an edit identical to the original file is dropped; zero surviving edits → `{ok:false, reason:"agent produced no effective edits"}`;
- `hasTodos` = any newContent contains `TODO(autoshim)`.
`claudeHealAgent().run` (pinned shapes):
```typescript
const stream = client.messages.stream({
  model: "claude-opus-5",
  max_tokens: 64000,
  system: systemPrompt,
  messages: [{ role: "user", content: userPayload }],
  output_config: { format: zodOutputFormat(HealOutput) },
});
const final = await stream.finalMessage();
const text = final.content.filter((b) => b.type === "text").map((b) => b.text).join("");
const parsed = HealOutput.safeParse(JSON.parse(text));
if (!parsed.success) throw new Error(`heal: unparsable agent output: ${parsed.error.message}`);
return parsed.data;
```

- [ ] **Step 1: Write the failing test** — `packages/core/test/heal.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { heal, HEAL_SYSTEM_PROMPT, type HealAgent } from "../src/heal.js";
import type { RepoAccess, VendorChange, ImpactReport } from "../src/types.js";

const repo: RepoAccess = {
  listFiles: async () => ["src/pay.ts"],
  read: async (p) => (p === "src/pay.ts" ? "line1\nconst x = charge.source;\nline3\n" : ""),
};
const change = { id: "chg_1", vendor_id: "stripe", classification: "breaking", raw_excerpt: "x".repeat(10000) } as unknown as VendorChange;
const impact: ImpactReport = {
  project_id: "p", change_id: "chg_1", languages: ["typescript"], impact_score: 6, patchable: true,
  files: [{ path: "src/pay.ts", lines: [2], reason: "entity: source" }],
};
const agentReturning = (edits: { path: string; newContent: string }[]): HealAgent => ({
  run: async (_sys, payload) => {
    expect(JSON.parse(payload).fileContents["src/pay.ts"]).toContain("charge.source");
    return { edits, what_changed: ["src/pay.ts: source -> payment_source"] };
  },
});

describe("heal", () => {
  it("accepts an in-bounds edit and computes changed lines", async () => {
    const out = await heal(agentReturning([{ path: "src/pay.ts", newContent: "line1\nconst x = charge.payment_source; // TODO(autoshim): verify\nline3\n" }]), repo, change, impact, undefined);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result.edits).toHaveLength(1);
      expect(out.result.hasTodos).toBe(true);
      expect(out.changedLines).toBe(2); // one removed + one added
    }
  });
  it("allows exactly one extra file, rejects two", async () => {
    const one = await heal(agentReturning([
      { path: "src/pay.ts", newContent: "changed\n" },
      { path: "src/imports.ts", newContent: "import x\n" },
    ]), repo, change, impact, undefined);
    expect(one.ok).toBe(true);
    const two = await heal(agentReturning([
      { path: "src/pay.ts", newContent: "changed\n" },
      { path: "a.ts", newContent: "x" }, { path: "b.ts", newContent: "y" },
    ]), repo, change, impact, undefined);
    expect(two.ok).toBe(false);
    if (!two.ok) expect(two.reason).toMatch(/outside allowed files/);
  });
  it("rejects oversized diffs and keeps the attempted edits", async () => {
    const big = Array.from({ length: 500 }, (_, i) => `new${i}`).join("\n");
    const out = await heal(agentReturning([{ path: "src/pay.ts", newContent: big }]), repo, change, impact, undefined, { maxFiles: 20, maxChangedLines: 400 });
    expect(out.ok).toBe(false);
    if (!out.ok) { expect(out.reason).toMatch(/diff too large/); expect(out.attempted).toHaveLength(1); }
  });
  it("drops no-op edits and fails when nothing effective remains", async () => {
    const out = await heal(agentReturning([{ path: "src/pay.ts", newContent: "line1\nconst x = charge.source;\nline3\n" }]), repo, change, impact, undefined);
    expect(out.ok).toBe(false);
  });
  it("truncates raw_excerpt in the payload to 4k", async () => {
    const spy: HealAgent = { run: async (_s, payload) => { expect(JSON.parse(payload).change.raw_excerpt.length).toBeLessThanOrEqual(4000); return { edits: [{ path: "src/pay.ts", newContent: "z\n" }], what_changed: [] }; } };
    await heal(spy, repo, change, impact, undefined);
  });
  it("system prompt carries the PRD rules", () => {
    for (const s of ["Draft PR only", "No refactors", "No new dependencies", "TODO(autoshim)"]) {
      expect(HEAL_SYSTEM_PROMPT).toContain(s);
    }
  });
});
```

- [ ] **Step 2: fail**, **Step 3: implement**, **Step 4: pass**, export.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(core): constrained heal agent with safety caps"`

---

### Task 13: Publish — templates, branch naming, decideAction, one-PR rule

**Files:**
- Create: `packages/core/src/publish.ts`
- Test: `packages/core/test/publish.test.ts`

**Interfaces:**
- Consumes: `VendorChange`, `ImpactReport`, `HealResult`, `PrInput`, `IssueInput`, `Publisher`, `Vendor`, `FileEdit` (2); `HealOutcome` (12); `fp8` (2).
- Produces:
```typescript
export function branchName(vendorId: string, fingerprint: string): string;         // `autoshim/${vendorId}/${fp8(fingerprint)}`
export function prTitle(vendor: Vendor, change: VendorChange): string;             // `fix(autoshim): adapt ${vendor.display_name} ${change.entities[0]?.name ?? change.title} (${change.classification})`
export function prBody(vendor: Vendor, change: VendorChange, heal: HealResult): string;   // PRD §13.2 template: ## Why / ## Sources / ## What I changed / ## Verify / footer
export function issueBody(vendor: Vendor, change: VendorChange, impact: ImpactReport | null, extra?: string): string; // excerpt + source urls (+ attempted-diff note)
export function issueTitle(vendor: Vendor, change: VendorChange): string;          // `[autoshim] ${vendor.display_name} ${change.title}`
export type Action =
  | { kind: "none"; why: string }
  | { kind: "issue"; input: IssueInput }
  | { kind: "pr"; input: PrInput };
export function decideAction(vendor: Vendor, change: VendorChange, impact: ImpactReport, healOutcome: HealOutcome | null, autoPr: boolean): Action;
export async function publish(publisher: Publisher, action: Action): Promise<{ url: string } | null>;
// pr action: findOpenAutoshimPr(vendorId) -> exists ? updateDraftPr(branch, input with "## Superseded change" section prepended note) : openDraftPr
```
decideAction matrix (spec §5 Publish + PRD §23):
- classification `docs_only` or `unknown` → none.
- `additive` → none (why: "additive; digest only").
- `breaking`/`deprecation`:
  - `autoPr && impact.patchable && healOutcome?.ok` → pr (labels `["autoshim"]`, draft true).
  - `impact.patchable && healOutcome && !healOutcome.ok` → issue, body includes `healOutcome.reason` and a fenced diff of `attempted` first-100-lines when present (fail loud).
  - not patchable (or !autoPr) → issue.

- [ ] **Step 1: Write the failing test** — `packages/core/test/publish.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { branchName, prTitle, prBody, issueTitle, issueBody, decideAction, publish } from "../src/publish.js";
import type { Publisher, Vendor, VendorChange, ImpactReport, PrInput, IssueInput } from "../src/types.js";

const vendor: Vendor = { id: "stripe", display_name: "Stripe", kind: "pack", sdk_packages: [] };
const change = {
  id: "chg_1", vendor_id: "stripe", source: "openapi", title: "Removed charges.source", summary: "s",
  classification: "breaking", breaking_confidence: 0.95,
  entities: [{ type: "param", name: "charges.source" }], source_urls: ["https://docs.stripe.com/changelog"],
  raw_excerpt: "EXCERPT", fingerprint: "sha256:" + "ab".repeat(32), created_at: "2026-09-01T00:00:00Z",
} as VendorChange;
const impact: ImpactReport = { project_id: "p", change_id: "chg_1", files: [{ path: "src/pay.ts", lines: [2], reason: "r" }], languages: ["typescript"], impact_score: 6, patchable: true };
const healOk = { ok: true as const, changedLines: 2, result: { edits: [{ path: "src/pay.ts", newContent: "x" }], whatChanged: ["src/pay.ts: a -> b"], hasTodos: false } };

describe("naming and templates", () => {
  it("branch, pr title, issue title", () => {
    expect(branchName("stripe", change.fingerprint)).toBe("autoshim/stripe/abababab");
    expect(prTitle(vendor, change)).toBe("fix(autoshim): adapt Stripe charges.source (breaking)");
    expect(issueTitle(vendor, change)).toBe("[autoshim] Stripe Removed charges.source");
  });
  it("pr body has Why/Sources/What I changed/Verify and the no-auto-merge footer", () => {
    const b = prBody(vendor, change, healOk.result);
    for (const s of ["## Why", "breaking (0.95)", "## Sources", "https://docs.stripe.com/changelog", "## What I changed", "src/pay.ts: a -> b", "## Verify", "Opened by Autoshim. I will not auto-merge."]) {
      expect(b).toContain(s);
    }
  });
  it("issue body carries excerpt and urls", () => {
    const b = issueBody(vendor, change, impact);
    expect(b).toContain("EXCERPT");
    expect(b).toContain("https://docs.stripe.com/changelog");
  });
});

describe("decideAction", () => {
  it("docs_only/unknown/additive -> none", () => {
    for (const c of ["docs_only", "unknown", "additive"] as const) {
      expect(decideAction(vendor, { ...change, classification: c }, impact, null, true).kind).toBe("none");
    }
  });
  it("breaking + patchable + heal ok + autoPr -> pr", () => {
    const a = decideAction(vendor, change, impact, healOk, true);
    expect(a.kind).toBe("pr");
    if (a.kind === "pr") { expect(a.input.draft).toBe(true); expect(a.input.labels).toEqual(["autoshim"]); expect(a.input.branch).toBe("autoshim/stripe/abababab"); }
  });
  it("heal failed -> issue with reason and attempted diff (fail loud)", () => {
    const a = decideAction(vendor, change, impact, { ok: false, reason: "diff too large (900 lines)", attempted: [{ path: "src/pay.ts", newContent: "n" }] }, true);
    expect(a.kind).toBe("issue");
    if (a.kind === "issue") expect(a.input.body).toContain("diff too large");
  });
  it("not patchable breaking -> issue; autoPr=false -> issue", () => {
    expect(decideAction(vendor, change, { ...impact, patchable: false, reason_if_not: "no_hits" }, null, true).kind).toBe("issue");
    expect(decideAction(vendor, change, impact, healOk, false).kind).toBe("issue");
  });
});

describe("publish one-PR-per-vendor rule", () => {
  function fakePub(existing: { branch: string; url: string } | null) {
    const log: string[] = [];
    const pub: Publisher = {
      openDraftPr: async (i: PrInput) => { log.push(`open:${i.branch}`); return { url: "https://pr/new" }; },
      updateDraftPr: async (branch: string, i: PrInput) => { log.push(`update:${branch}`); expect(i.body).toContain("Superseded change"); return { url: "https://pr/existing" }; },
      findOpenAutoshimPr: async () => existing,
      openIssue: async (_i: IssueInput) => ({ url: "https://issue/1" }),
    };
    return { pub, log };
  }
  const prAction = decideAction(vendor, change, impact, healOk, true);
  it("opens when none exists", async () => {
    const { pub, log } = fakePub(null);
    const r = await publish(pub, prAction);
    expect(r!.url).toBe("https://pr/new");
    expect(log).toEqual(["open:autoshim/stripe/abababab"]);
  });
  it("updates the existing vendor PR instead of opening a second", async () => {
    const { pub, log } = fakePub({ branch: "autoshim/stripe/00000000", url: "https://pr/existing" });
    const r = await publish(pub, prAction);
    expect(r!.url).toBe("https://pr/existing");
    expect(log).toEqual(["update:autoshim/stripe/00000000"]);
  });
  it("none -> null, issue -> openIssue", async () => {
    const { pub } = fakePub(null);
    expect(await publish(pub, { kind: "none", why: "w" })).toBeNull();
    const issue = decideAction(vendor, change, { ...impact, patchable: false }, null, true);
    expect((await publish(pub, issue))!.url).toBe("https://issue/1");
  });
});
```

- [ ] **Step 2: fail**, **Step 3: implement `publish.ts`** (PR body template exactly PRD §13.2 with `{vendor}/{title}/{classification}/{confidence}` interpolation; Verify checklist items `- [ ] run tests` and `- [ ] check staging against vendor test mode`), **Step 4: pass**, export.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(core): publish decision matrix, templates, one-PR rule"`

---

### Task 14: CLI state layer + init / discover / add / ignore

**Files:**
- Create: `packages/cli/src/state.ts`, `packages/cli/src/vendorResolve.ts`, `packages/cli/src/commands.ts`, rewrite `packages/cli/src/index.ts`
- Test: `packages/cli/test/state.test.ts`, `packages/cli/test/commands.test.ts`

**Interfaces:**
- Consumes: everything exported by `@autoshim/core` (Tasks 2–13); pack YAMLs are bundled by reading the repo's `packs/` dir resolved relative to the installed package (`new URL("../../..", import.meta.url)` in dev; also honor `AUTOSHIM_PACKS_DIR` env override so tests and the published tarball can point elsewhere — the cli package.json gains `"files": ["dist", "packs"]` and a `prepack` script copying `packs/` in).
- Produces:
```typescript
// state.ts — all functions take a rootDir (default process.cwd())
export interface ProjectConfig {
  version: 1;
  project: { languages: string[]; auto_pr: boolean; schedule: string };
  vendors: (Pick<Vendor, "id"> & Partial<Vendor>)[];
  watches: Watch[];
  ignores: { fingerprint?: string; entity?: string }[];
}
export function readConfig(rootDir: string): ProjectConfig | null;              // .autoshim/config.yaml
export function writeConfig(rootDir: string, c: ProjectConfig): void;
export function readSourceState(rootDir: string, key: string): SourceState | null;   // .autoshim/cache/<sha1(key)>.json
export function writeSourceState(rootDir: string, key: string, s: SourceState): void;
export function stateKey(vendorId: string, target: WatchTarget): string;        // `${vendorId}:${target.type}:${target.url ?? target.repo}`
export function recordChange(rootDir: string, c: VendorChange): boolean;        // writes .autoshim/changes/<id>.json; false if id exists (dedupe) 
export function listChanges(rootDir: string): VendorChange[];
export function isIgnored(c: ProjectConfig, change: VendorChange): boolean;     // fingerprint match or any entity name match
export function fsRepoAccess(rootDir: string): RepoAccess;                      // walks rootDir minus Global-Constraints skip dirs

// vendorResolve.ts
export interface AddInput { openapi?: string; changelog?: string; docs?: string; repo?: string; pkg?: string; name?: string }
export async function resolveVendor(input: AddInput, registry: PackRegistry, fetchFn?: typeof fetch): Promise<{ vendor: Vendor; watch: Watch }>;
// pkg "npm:x"/"pypi:x" -> registry.byPackage first; unknown npm/pypi package -> GET registry metadata
// (https://registry.npmjs.org/<n> -> homepage, repository.url; https://pypi.org/pypi/<n>/json -> info.home_page/project_urls)
// to prefill homepage/github_repo. Generic id: `custom_${slug(name ?? hostname-or-package)}` (slug: lowercase, [^a-z0-9]+ -> _).
// Targets: openapi url -> {type:"openapi",url,detection:"exact"}; repo -> {type:"github_release",repo};
// changelog/docs -> {type:"page",url,detection:"semantic",instructions:"Alert on breaking changes, deprecations, removals, newly required fields, and new API versions. Ignore navigation and marketing."}
// At least one input required, else throw.

// commands.ts — each returns a printable summary object, no process.exit inside
export async function cmdInit(rootDir: string): Promise<{ created: boolean; languages: string[]; detected: DetectedIntegration[] }>;
export async function cmdDiscover(rootDir: string): Promise<DetectedIntegration[]>;
export async function cmdAdd(rootDir: string, input: AddInput & { test?: boolean }): Promise<{ vendor: Vendor; watch: Watch; persisted: boolean }>;
export function cmdIgnore(rootDir: string, opt: { fingerprint?: string; entity?: string }): ProjectConfig;
```
`cmdInit`: build fsRepoAccess → `detectLanguages` + `discover`; write config with `auto_pr: true`, `schedule: "6h"`, vendors = pack vendors found (id-only entries) with a watch per pack's `watch` list; unknown integrations reported in the return for the caller to print "add a URL to watch". Idempotent: existing config → `created:false`, config untouched.
`cmdAdd`: resolveVendor → when `test` true just return (`persisted:false`); else append vendor+watch to config (replace same id).
`index.ts`: commander wiring for `init|discover|add|watch|simulate|impact|heal|ignore` printing JSON with `--json`, human lines otherwise. Command handlers for watch/simulate/impact/heal call Task 15's `runWatch`/`runSimulate` etc.

- [ ] **Step 1: Write failing tests.** `packages/cli/test/state.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig, readSourceState, writeSourceState, stateKey, recordChange, listChanges, isIgnored, type ProjectConfig } from "../src/state.js";
import type { VendorChange } from "@autoshim/core";

const cfg: ProjectConfig = {
  version: 1, project: { languages: ["typescript"], auto_pr: true, schedule: "6h" },
  vendors: [{ id: "stripe" }], watches: [{ vendor_id: "stripe", targets: [{ type: "openapi", url: "u" }], status: "active" }],
  ignores: [{ fingerprint: "sha256:aa" }, { entity: "charges.source" }],
};
const change = { id: "chg_x", vendor_id: "stripe", fingerprint: "sha256:bb", entities: [{ type: "param", name: "other" }] } as unknown as VendorChange;

describe("state", () => {
  it("config roundtrip; null when absent", () => {
    const d = mkdtempSync(join(tmpdir(), "as-"));
    expect(readConfig(d)).toBeNull();
    writeConfig(d, cfg);
    expect(readConfig(d)).toEqual(cfg);
  });
  it("source state roundtrip keyed by stateKey", () => {
    const d = mkdtempSync(join(tmpdir(), "as-"));
    const k = stateKey("stripe", { type: "openapi", url: "https://u" });
    expect(readSourceState(d, k)).toBeNull();
    writeSourceState(d, k, { hash: "h", updated_at: "t" });
    expect(readSourceState(d, k)!.hash).toBe("h");
  });
  it("recordChange dedupes by id and listChanges reads back", () => {
    const d = mkdtempSync(join(tmpdir(), "as-"));
    expect(recordChange(d, change)).toBe(true);
    expect(recordChange(d, change)).toBe(false);
    expect(listChanges(d).map((c) => c.id)).toEqual(["chg_x"]);
  });
  it("isIgnored matches fingerprint or entity", () => {
    expect(isIgnored(cfg, change)).toBe(false);
    expect(isIgnored(cfg, { ...change, fingerprint: "sha256:aa" })).toBe(true);
    expect(isIgnored(cfg, { ...change, entities: [{ type: "param", name: "charges.source" }] })).toBe(true);
  });
});
```

`packages/cli/test/commands.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdInit, cmdDiscover, cmdAdd, cmdIgnore } from "../src/commands.js";
import { readConfig } from "../src/state.js";

function sampleRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "as-"));
  writeFileSync(join(d, "package.json"), JSON.stringify({ dependencies: { stripe: "^16.0.0", "klaviyo-api": "^10.0.0" } }));
  mkdirSync(join(d, "src"));
  writeFileSync(join(d, "src", "a.ts"), "import Stripe from 'stripe';");
  return d;
}

describe("cmdInit", () => {
  it("writes config with detected stripe watch and reports the unknown package", async () => {
    const d = sampleRepo();
    const r = await cmdInit(d);
    expect(r.created).toBe(true);
    expect(r.languages).toContain("typescript");
    const cfg = readConfig(d)!;
    expect(cfg.vendors.map((v) => v.id)).toContain("stripe");
    expect(cfg.watches.find((w) => w.vendor_id === "stripe")!.targets.length).toBeGreaterThan(0);
    expect(r.detected.find((x) => x.package_name === "klaviyo-api")!.vendor_id).toBeNull();
    expect((await cmdInit(d)).created).toBe(false);   // idempotent
  });
});

describe("cmdAdd", () => {
  it("adds a generic openapi vendor and persists", async () => {
    const d = sampleRepo();
    await cmdInit(d);
    const r = await cmdAdd(d, { openapi: "https://api.acme.com/openapi.json", name: "Acme" });
    expect(r.vendor.id).toBe("custom_acme");
    expect(r.watch.targets[0]).toMatchObject({ type: "openapi", detection: "exact" });
    expect(readConfig(d)!.vendors.map((v) => v.id)).toContain("custom_acme");
  });
  it("--test does not persist", async () => {
    const d = sampleRepo();
    await cmdInit(d);
    const r = await cmdAdd(d, { changelog: "https://acme.com/changelog", name: "Acme", test: true });
    expect(r.persisted).toBe(false);
    expect(readConfig(d)!.vendors.map((v) => v.id)).not.toContain("custom_acme");
  });
  it("throws when no input given", async () => {
    const d = sampleRepo();
    await cmdInit(d);
    await expect(cmdAdd(d, {})).rejects.toThrow();
  });
});

describe("cmdIgnore", () => {
  it("appends to ignores", async () => {
    const d = sampleRepo();
    await cmdInit(d);
    cmdIgnore(d, { entity: "charges.source" });
    expect(readConfig(d)!.ignores).toContainEqual({ entity: "charges.source" });
  });
});
```

- [ ] **Step 2: fail**, **Step 3: implement** (set `AUTOSHIM_PACKS_DIR` in `packages/cli/test` via vitest setup to the repo's `packs/`), **Step 4: pass**.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(cli): state layer, init/discover/add/ignore"`

---

### Task 15: CLI pipeline — watch / simulate / impact / heal + GitHub publisher

**Files:**
- Create: `packages/cli/src/pipeline.ts`, `packages/cli/src/githubPublisher.ts`
- Modify: `packages/cli/src/index.ts` (wire commands), `packages/cli/src/commands.ts` (re-export run* helpers)
- Test: `packages/cli/test/pipeline.test.ts`

**Interfaces:**
- Consumes: all core exports; `state.ts` (14).
- Produces:
```typescript
export interface PipelineDeps {
  sources: Record<"openapi" | "github_release" | "page", ChangeSource>;
  publisher: Publisher | null;                 // null => dry-run/no-token: print instead
  healAgent: HealAgent | null;                 // null => report skipped
  registry: PackRegistry;
  now?: () => Date;
  log?: (line: string) => void;
}
export interface WatchOpts { once: true; noHeal?: boolean; vendor?: string; dryRun?: boolean }
export interface WatchReport {
  polled: { vendor: string; target: string; changes: number; skipped?: string; error?: string }[];
  actions: { changeId: string; kind: "pr" | "issue" | "none" | "dry-run"; url?: string; why?: string }[];
}
export async function runWatch(rootDir: string, deps: PipelineDeps, opts: WatchOpts): Promise<WatchReport>;
export async function runSimulate(rootDir: string, deps: PipelineDeps, vendorId: string, specPathOrUrl: string, dryRun: boolean): Promise<WatchReport>;
// simulate: overwrite the vendor's openapi target URL with specPathOrUrl for one poll (state key unchanged so the
// previous snapshot is the baseline), then run the same downstream as runWatch.
export async function runImpact(rootDir: string, deps: PipelineDeps, changeId: string): Promise<ImpactReport>;
export async function runHeal(rootDir: string, deps: PipelineDeps, changeId: string | undefined, dryRun: boolean): Promise<WatchReport["actions"]>;
export function makeGithubPublisher(rootDir: string, opts?: { token?: string; execFn?: typeof execFileSync; octokit?: unknown }): Publisher | null;
```
`runWatch` flow per active watch (filtered by `opts.vendor`): resolve `Vendor` (pack registry for id-only entries, config record for generic) → for each target pick `deps.sources[target.type]`, `poll(target, vendor, readSourceState(...))`, `writeSourceState` — EXCEPT when `dryRun` (state untouched). New changes: `recordChange` (skip dupes), drop `isIgnored`, then unless `noHeal`: `buildIndex(fsRepoAccess)` once per run → `scanImpact` → maybe `heal` (patchable ∧ breaking/deprecation ∧ healAgent) → `decideAction(vendor, change, impact, healOutcome, cfg.project.auto_pr)` → publisher ? `publish` : record `{kind:"dry-run", why: renderedTitle}`. Missing healAgent where needed → treat as heal `null` and let decideAction fall to issue, log `skipped: needs ANTHROPIC_API_KEY`. Publisher `openDraftPr` throwing → catch, log branch+body so the user can open manually (spec §9), action kind "none" with why=error.
`makeGithubPublisher`: null when `!token && !process.env.GITHUB_TOKEN`. Implementation (untested by unit tests except construction-returns-null; integration covered by fakes): create branch from HEAD via `git` (`execFn("git", ["checkout", "-b", branch])` on a temp worktree — use `git worktree add`), write edits, commit, `git push -u origin branch`, then Octokit `pulls.create({draft: true, ...})` + `issues.addLabels`; `findOpenAutoshimPr` = `pulls.list({state:"open"})` filtered by `head.ref.startsWith(\`autoshim/${vendorId}/\`)`; `openIssue` = `issues.create`. Repo slug parsed from `git remote get-url origin`.

- [ ] **Step 1: Write the failing test** — `packages/cli/test/pipeline.test.ts` (everything faked; this is the heart of the CLI):

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runWatch, runSimulate, type PipelineDeps } from "../src/pipeline.js";
import { cmdInit, cmdAdd, cmdIgnore } from "../src/commands.js";
import { openApiSource, loadPacks, type Publisher, type HealAgent } from "@autoshim/core";
import { readdirSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const petA = readFileSync(join(root, "fixtures/specs/petstore-a.json"), "utf8");
const petB = readFileSync(join(root, "fixtures/specs/petstore-b.json"), "utf8");
const registry = () => {
  const dir = join(root, "packs");
  return loadPacks(readdirSync(dir).filter((f) => f.endsWith(".yaml") && !f.startsWith("_")).map((f) => readFileSync(join(dir, f), "utf8")));
};

function petRepo(): { dir: string; spec: string } {
  const dir = mkdtempSync(join(tmpdir(), "as-"));
  mkdirSync(join(dir, "src"));
  // a file that uses the petstore API so impact hits
  writeFileSync(join(dir, "src", "pets.ts"), `export const list = () => fetch("https://api.pets.dev/v1/stores");\n`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: {} }));
  const spec = join(dir, "vendor-spec.json");
  writeFileSync(spec, petA);
  return { dir, spec };
}

function deps(overrides?: Partial<PipelineDeps>): { d: PipelineDeps; prs: any[]; issues: any[] } {
  const prs: any[] = []; const issues: any[] = [];
  const publisher: Publisher = {
    openDraftPr: async (i) => { prs.push(i); return { url: `https://pr/${prs.length}` }; },
    updateDraftPr: async (_b, i) => { prs.push(i); return { url: "https://pr/updated" }; },
    findOpenAutoshimPr: async () => null,
    openIssue: async (i) => { issues.push(i); return { url: "https://issue/1" }; },
  };
  const healAgent: HealAgent = { run: async () => ({ edits: [{ path: "src/pets.ts", newContent: "export const list = () => fetch(\"https://api.pets.dev/v1/shops\");\n" }], what_changed: ["src/pets.ts: /v1/stores -> /v1/shops"] }) };
  const d: PipelineDeps = {
    sources: { openapi: openApiSource(), github_release: { kind: "github_release", poll: async (_t, _v, p) => ({ state: p ?? { updated_at: "x" }, changes: [] }) }, page: { kind: "page", poll: async (_t, _v, p) => ({ state: p ?? { updated_at: "x" }, changes: [], skipped: "needs CONTEXT_API_KEY" }) } },
    publisher, healAgent, registry: registry(), log: () => {}, ...overrides,
  };
  return { d, prs, issues };
}

async function setupWatched(dir: string, spec: string) {
  await cmdInit(dir);
  await cmdAdd(dir, { openapi: spec, name: "Pets" });
}

describe("runWatch end-to-end with local spec", () => {
  it("seed run emits nothing; mutation run opens one draft PR", async () => {
    const { dir, spec } = petRepo();
    await setupWatched(dir, spec);
    const { d, prs } = deps();
    const r1 = await runWatch(dir, d, { once: true });
    expect(r1.actions).toEqual([]);
    writeFileSync(spec, petB);
    const r2 = await runWatch(dir, d, { once: true });
    expect(prs).toHaveLength(1);
    expect(prs[0].branch).toMatch(/^autoshim\/custom_pets\/[0-9a-f]{8}$/);
    expect(prs[0].draft).toBe(true);
    expect(prs[0].body).toContain("I will not auto-merge");
    expect(r2.actions[0].kind).toBe("pr");
  });
  it("no heal agent -> issue fallback with skipped log; ignored fingerprint -> nothing", async () => {
    const { dir, spec } = petRepo();
    await setupWatched(dir, spec);
    const { d, issues } = deps({ healAgent: null });
    await runWatch(dir, d, { once: true });
    writeFileSync(spec, petB);
    const r = await runWatch(dir, d, { once: true });
    expect(issues).toHaveLength(1);
    expect(issues[0].title).toMatch(/^\[autoshim\] Pets /);
    const fp = r.actions[0]?.changeId; // second identical mutation is deduped by recordChange anyway; test ignore via entity
    cmdIgnore(dir, { entity: "GET /v1/stores" });
    writeFileSync(spec, petA); await runWatch(dir, d, { once: true }); // reset baseline
    writeFileSync(spec, petB);
    const r3 = await runWatch(dir, d, { once: true });
    expect(r3.actions).toEqual([]);
  });
  it("dry run publishes nothing and leaves state untouched", async () => {
    const { dir, spec } = petRepo();
    await setupWatched(dir, spec);
    const { d, prs, issues } = deps();
    await runWatch(dir, d, { once: true });
    writeFileSync(spec, petB);
    const r = await runWatch(dir, d, { once: true, dryRun: true });
    expect(prs).toHaveLength(0); expect(issues).toHaveLength(0);
    expect(r.actions[0].kind).toBe("dry-run");
    const again = await runWatch(dir, d, { once: true });   // state was not advanced
    expect(again.actions[0].kind).toBe("pr");
  });
});

describe("runSimulate", () => {
  it("injects a new spec version against the stored baseline", async () => {
    const { dir, spec } = petRepo();
    await setupWatched(dir, spec);
    const { d, prs } = deps();
    await runWatch(dir, d, { once: true });
    const mutated = join(dir, "mutated.json");
    writeFileSync(mutated, petB);
    const r = await runSimulate(dir, d, "custom_pets", mutated, false);
    expect(prs).toHaveLength(1);
    expect(r.actions[0].kind).toBe("pr");
  });
});
```

- [ ] **Step 2: fail**, **Step 3: implement `pipeline.ts`** then `githubPublisher.ts` and wire `index.ts` (env wiring: publisher from GITHUB_TOKEN, healAgent from ANTHROPIC_API_KEY via `claudeHealAgent()`, extractor via `claudeExtractor()` into `githubReleaseSource`/`contextDevSource`; every missing key degrades per Global Constraints, never throws at startup), **Step 4: pass** (`pnpm -r test` green), **Step 5:** manual smoke: `cd $(mktemp -d) && git init && node <repo>/packages/cli/dist/index.js init` after `pnpm -r build`.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(cli): watch/simulate pipeline and github publisher"`

---

### Task 16: Quality-bar integration tests + README

**Files:**
- Test: `packages/cli/test/quality-bars.test.ts`
- Create: `README.md`, `packages/cli/README.md` (symlink-free copy)

**Interfaces:** consumes everything; adds nothing new. Each spec quality bar (§ "Quality bar" in the spec = PRD §21) gets a named test. Bars #1/#2 reuse Task 15 helpers with the petstore pair standing in for a real spec (the real-GitHub-spec differ run is Task 6's net-gated test). Bar #3 uses a fake page source; #4 uses `cmdDiscover` + `cmdAdd`; #5 runs two vendors in one `runWatch`.

- [ ] **Step 1: Write the tests** — `packages/cli/test/quality-bars.test.ts` (helpers `petRepo`/`deps`/`setupWatched` copied from Task 15's test file — duplication is fine, tasks may run out of order):

```typescript
import { describe, it, expect } from "vitest";
// ...same imports and helper functions (petRepo, deps, registry, setupWatched) as pipeline.test.ts...
import { runWatch } from "../src/pipeline.js";
import { cmdInit, cmdAdd, cmdDiscover } from "../src/commands.js";

describe("quality bars (spec §21)", () => {
  it("QB1: pasting an OpenAPI URL creates a watch", async () => {
    const { dir } = petRepo();
    await cmdInit(dir);
    const r = await cmdAdd(dir, { openapi: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json", name: "GitHub REST" });
    expect(r.persisted).toBe(true);
    expect(r.watch.targets[0]).toMatchObject({ type: "openapi", detection: "exact" });
  });
  it("QB2: mutated fixture spec produces a draft PR in a sample repo", async () => {
    // identical body to Task 15's "mutation run opens one draft PR" test — this is the named quality bar
  });
  it("QB3: changelog-only vendor (no OpenAPI) still files an issue with excerpt + urls", async () => {
    const { dir } = petRepo();
    await cmdInit(dir);
    await cmdAdd(dir, { changelog: "https://acme.com/changelog", name: "Acme" });
    const { d, issues } = deps({
      healAgent: null,
      sources: {
        openapi: { kind: "openapi", poll: async (_t, _v, p) => ({ state: p ?? { updated_at: "x" }, changes: [] }) },
        github_release: { kind: "github_release", poll: async (_t, _v, p) => ({ state: p ?? { updated_at: "x" }, changes: [] }) },
        page: { kind: "page", poll: async (_t, v, _p) => ({ state: { updated_at: "x" }, changes: [{
          id: "chg_deadbeef", vendor_id: v.id, source: "changelog", title: "Endpoint removed", summary: "s",
          classification: "breaking", breaking_confidence: 0.8, entities: [{ type: "endpoint", name: "GET /v2/things" }],
          source_urls: ["https://acme.com/changelog#x"], raw_excerpt: "the excerpt text",
          fingerprint: "sha256:" + "cd".repeat(32), created_at: "2026-09-01T00:00:00Z" }] }) },
      },
    });
    await runWatch(dir, d, { once: true });
    expect(issues).toHaveLength(1);
    expect(issues[0].body).toContain("the excerpt text");
    expect(issues[0].body).toContain("https://acme.com/changelog#x");
  });
  it("QB4: unknown package is discovered and attachable in one call", async () => {
    const { dir } = petRepo();
    // add an unknown dep to the sample repo's package.json first
    // ... write package.json with klaviyo-api, then:
    const found = await cmdDiscover(dir);
    const unknown = found.find((f) => f.package_name === "klaviyo-api");
    expect(unknown?.vendor_id).toBeNull();
    const r = await cmdAdd(dir, { pkg: "npm:klaviyo-api", changelog: "https://developers.klaviyo.com/changelog" });
    expect(r.vendor.id).toBe("custom_klaviyo_api");
  });
  it("QB5: two vendors changing produce two separate PRs, no mashup", async () => {
    const { dir, spec } = petRepo();
    await setupWatched(dir, spec);                       // vendor 1: custom_pets (openapi)
    const spec2 = join(dir, "spec2.json");
    writeFileSync(spec2, petA);
    await cmdAdd(dir, { openapi: spec2, name: "Zoo" });  // vendor 2: custom_zoo
    const { d, prs } = deps();
    await runWatch(dir, d, { once: true });              // seed both
    writeFileSync(spec, petB);
    writeFileSync(spec2, petB);
    await runWatch(dir, d, { once: true });
    expect(prs).toHaveLength(2);
    const branches = prs.map((p) => p.branch);
    expect(branches.some((b: string) => b.includes("/custom_pets/"))).toBe(true);
    expect(branches.some((b: string) => b.includes("/custom_zoo/"))).toBe(true);
  });
});
```
(Executor: QB4 needs `resolveVendor` to not hit the real npm registry — pass a fetchFn returning 404 through `cmdAdd`'s optional deps, or accept `vendor_id` resolution from the explicit changelog input alone; wire an optional `fetchFn` through `cmdAdd` for this.)

**AMENDMENT (2026-09-01):** add one more named test to this task — `packages/core/test/no-network.test.ts`: statically scan `packages/core/src/**` EXCLUDING `src/sources/` and `src/extract.ts` and `src/heal.ts` for network primitives (`fetch(`, `http.request`, `https.request`, `net.connect`, `XMLHttpRequest`, `WebSocket`) and assert zero matches — mechanical proof of the "core is pure" claim for the README.

- [ ] **Step 2: fail → implement glue gaps → pass** (`pnpm test` fully green from repo root).
- [ ] **Step 3: Write `README.md`:** what Autoshim is (one-liner from spec), quickstart (`npx autoshim init` → `add --openapi` → `watch --once`), env vars table (GITHUB_TOKEN / ANTHROPIC_API_KEY / CONTEXT_API_KEY and what degrades without each), the honesty line from the PRD ("Any vendor can be watched. Pack vendors get smarter patches."), pack contribution pointer, Apache-2.0.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "test: quality-bar integration suite; docs: README"`

---

## Self-Review (completed at planning time)

1. **Spec coverage:** discover→T4; packs→T3; add-vendor incl. registry-metadata prefill→T14; watch openapi/local→T7, github_release→T9, page/Context.dev→T10; understand/classify→T6+T8; fingerprint/dedupe/ignore→T2+T14; impact→T11; heal+caps→T12; publish templates/one-PR/branch→T13; CLI surface §8→T14+T15; error handling §9→T7/T9/T10/T15 tests; quality bars §21→T6 (github pair) + T16. Not covered anywhere (deliberate, spec §11): sitemap/extract targets, Go/Ruby healing, hosted anything. The `.autoshim/config.yaml` `schedule` field is written but only informational, matching the spec.
2. **Placeholders:** QB2 body intentionally references the identical Task-15 test by content; executor copies it. Pack seed data for 4 packs is specified as field lists rather than full YAML — the stripe.yaml example plus field lists is complete instruction, not a TBD.
3. **Type consistency check done:** `HealResult.whatChanged` (camel) vs agent JSON `what_changed` (wire) — `heal()` maps between them (T12 produces `HealResult`, T13 consumes `whatChanged`). `PollResult.skipped`, `SourceState.snapshot`, `fp8`, `branchName` names verified consistent across T7/T9/T10/T13/T15.

---

### Task 17: MCP server (added 2026-09-01 per strategy decision)

**Files:**
- Create: `packages/cli/src/mcp.ts`
- Modify: `packages/cli/src/index.ts` (add `mcp` subcommand), `packages/cli/package.json` (dep `@modelcontextprotocol/sdk`)
- Test: `packages/cli/test/mcp.test.ts`

**Interfaces:**
- Consumes: `cmdDiscover` (T14), `runWatch`, `runSimulate`, `runImpact`, `runHeal`, `PipelineDeps` (T15).
- Produces: `autoshim mcp` — a stdio MCP server exposing five tools: `discover`, `watch_once` (arg: vendor?, always no-publish/dry-run), `impact` (arg: change_id), `heal_dry_run` (arg: change_id?), `list_changes`. Each returns the same JSON the CLI's `--json` mode prints. The server NEVER publishes (no PRs/issues over MCP in v1 — read-only analysis; healing returns the diff text).
- Dep exception to the Global Constraints whitelist, ruled by controller: `@modelcontextprotocol/sdk` is allowed (official SDK, required for the channel).

- [ ] **Step 1: Write the failing test** — `packages/cli/test/mcp.test.ts`: construct the server object via an exported `buildMcpServer(rootDir, deps)` factory (do not spawn stdio in tests); assert it registers exactly the five tools with the names above and that calling the `discover` tool handler on a fixture repo returns JSON containing `package_name` entries. Use the same fixture-repo helper pattern as `commands.test.ts`.
- [ ] **Step 2: fail**, **Step 3: implement** with `@modelcontextprotocol/sdk` (McpServer + StdioServerTransport; `registerTool` per tool; `autoshim mcp` runs `await server.connect(new StdioServerTransport())`). Follow the SDK's current README for exact imports at execution time — do not guess from memory.
- [ ] **Step 4: pass**, **Step 5: Commit** — `git add -A && git commit -m "feat(cli): mcp server exposing discover/watch/impact/heal tools"`
