# Autoshim (autoshim.com) — Sub-project 1: OSS CLI + core pipeline (DRAFT, awaiting approval)

Status: DRAFT — written after brainstorming against the PRD. Not yet approved.
Source: PRD "Autoshim" (2026-08-26), reinterpreted; deviations are called out explicitly.

## 0. Why this document exists

The PRD describes at least four independent subsystems: an OSS CLI, a hosted
API+worker, a GitHub App, and a dashboard. That is too large for one spec.
The PRD's own launch criterion (§20) is:

> Launch when **generic watch + spec diff + draft PR on JS** works.

That criterion is fully satisfiable by an OSS CLI with no hosted component.
So this spec covers only sub-project 1. Everything in it is reused unchanged by
the hosted product later because all logic lives in `@autoshim/core` behind
three interfaces (`ChangeSource`, `RepoAccess`, `Publisher`); the CLI is just the
first host.

### Decomposition

| Sub-project | Delivers | Depends on |
|---|---|---|
| **SP1 (this spec)** | `@autoshim/core` + `autoshim` CLI: discover, packs, add vendor, watch (openapi / github_release local; page via Context.dev), classify, impact, heal, draft PR / Issue | — |
| SP2 | GitHub Action wrapper (scheduled `watch --once` with cached state), Context.dev `extract`/sitemap targets, 20 packs | SP1 |
| SP3 | Hosted API + worker + GitHub App, webhooks (`/webhooks/context`, `/webhooks/github`), multi-repo fanout, slash commands | SP1 |
| SP4 | Dashboard, email/Slack notifications, pricing | SP3 |

## 1. Assumptions (each overridable — say so and I'll adjust)

1. **Context.dev is the web-change layer, including in the CLI.** Per PRD §16
   the CLI uses the user's `CONTEXT_API_KEY`. SP1 ships a Context.dev adapter
   for `page` targets. `openapi` and `github_release` targets are polled locally
   (PRD §9 says releases are "Autoshim poller, not Context.dev"; raw spec files
   need only a hash compare). With no key, page targets report
   `needs CONTEXT_API_KEY`; spec/release targets work keyless.
   *Flip:* if Context.dev should be optional in the CLI, I'll add a local
   page-diff source in SP2.
2. **Healer in SP1 = constrained agent pass (PRD strategy 3) only.** Strategies
   1–2 (deterministic SDK/raw-HTTP rewrites) are deferred; the impact scan
   already gives the agent exact files+lines, which captures most of their
   value. Agent = Claude via the Anthropic SDK.
3. **Languages:** JS/TS + Python for discover + impact + heal. Go/Ruby: discover
   only (`go.mod`, `Gemfile.lock`), issues not PRs — matches PRD §25.
4. **5 seed packs** in SP1 (stripe, github, openai, shopify, slack) plus
   `_template.yaml`. The remaining 15+ are data work for SP2.
5. **Exact Context.dev API shapes are resolved at implementation time** from
   their docs, not guessed here. The spec commits only to what the PRD states:
   monitors (create/list/delete), `web-extract` with a JSON schema, and the
   webhook contract (`X-Context-Signature` HMAC, ≤300s skew, dedupe on ids).
6. **Stack:** TypeScript, pnpm workspaces, Node ≥ 20, vitest. No DB in SP1 —
   state is files under `.autoshim/`.
7. **Distribution:** `npx autoshim`, Apache-2.0. Packs live in the same repo.

## 2. Approaches considered

- **A. Hosted-first (PRD phase order).** Build API/worker/App in phases 1–3,
  CLI as thin client. *Rejected:* infra before signal; can't demo for ~2 weeks;
  the PRD's launch bar doesn't need it.
- **B. Core-first, CLI as first host (chosen).** All pipeline logic as pure
  functions in `@autoshim/core` over three small interfaces. CLI wires them to
  the local filesystem + git + Octokit. Hosted later wires the same core to
  Postgres + GitHub App. Demoable in days; every stage unit-testable with
  fixtures.
- **C. GitHub Action only.** Skip the CLI. *Rejected:* worse local dev loop;
  the Action is a 20-line wrapper around B anyway (SP2).

## 3. Architecture (SP1)

```
packages/
  core/          @autoshim/core — no I/O except through injected interfaces
    types/       VendorChange, SpecDiff, ImpactReport, Pack, Watch, ... (PRD §6, §10–12 verbatim)
    packs/       YAML loader + registry (package name → pack id, import patterns)
    discover/    manifest parsers → DetectedIntegration[]
    vendor/      resolve generic vendor from URL/repo/package (npm/pypi metadata)
    sources/     ChangeSource impls: openapi (local hash), githubRelease (local poll), contextDev (page)
    specdiff/    OpenAPI normalizer + differ → SpecDiff + classification
    classify/    VendorChange builder: from SpecDiff, from release notes, from extract JSON
    impact/      file index + scorer → ImpactReport
    heal/        agent pass (Claude) → FileEdit[] with safety caps
    publish/     PR / Issue body templates; Publisher interface
  cli/           autoshim — commander; .autoshim/ state; git ops; Octokit publisher
packs/           *.yaml + *.extract.json (bundled into cli at build)
fixtures/        sample specs (incl. github REST spec pair), sample repos (js, py)
```

### Interfaces (the seams the hosted product reuses)

```ts
interface ChangeSource {
  kind: "openapi" | "github_release" | "page"
  poll(target: WatchTarget, prev: SourceState | null): Promise<{ state: SourceState; changes: VendorChange[] }>
}
interface RepoAccess {            // CLI: local fs; hosted: GitHub contents API / clone
  listFiles(globs, ignore): Promise<string[]>
  read(path): Promise<string>
}
interface Publisher {             // CLI: git + Octokit; hosted: GitHub App installation token
  openDraftPr(input: PrInput): Promise<{ url: string }>
  updateDraftPr(id, input): Promise<void>
  findOpenAutoshimPr(vendorId): Promise<{ id; branch } | null>
  openIssue(input: IssueInput): Promise<{ url: string }>
}
```

## 4. State model (CLI)

`.autoshim/config.yaml` — committed. Vendors + watches for this repo.
```yaml
version: 1
project:
  languages: [typescript, python]   # from discover
  auto_pr: true
  schedule: 6h                       # informational; CLI is run by cron/CI
vendors:
  - id: stripe            # pack vendor: only the id
  - id: custom_acme       # generic vendor: full record (PRD §6 Vendor)
    display_name: Acme LMS
    openapi_url: https://api.acme.com/openapi.json
    changelog_url: https://acme.com/changelog
watches:
  - vendor_id: stripe
    targets: [{ type: openapi, url: ... }, { type: github_release, repo: stripe/openapi }, { type: page, url: ... }]
    status: active
ignores:
  - fingerprint: "sha256:..."
  - entity: "charges.source"
```

`.autoshim/cache/` — gitignored. Per-target `SourceState` (spec hash + last
snapshot for diffing, last release tag, Context.dev monitor id + last change id)
and the repo file index. `.autoshim/changes/` — gitignored, one JSON per
`VendorChange` seen (audit trail; hosted moves this to Postgres).

## 5. Pipeline stages

**Discover** (`autoshim discover`): parse `package.json` + lockfiles
(`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`), `requirements.txt`,
`pyproject.toml`, `poetry.lock`, `Pipfile.lock`, `go.mod`, `Gemfile.lock`.
Map names → pack ids via registry. Unknown packages become
`DetectedIntegration{vendor_id: null}`; best-effort homepage/docs/repo lookup
from npm/PyPI registry metadata so `autoshim add` can be one confirmation.

**Add vendor** (`autoshim add --openapi <url> | --changelog <url> | --docs <url> | --repo o/n | --package npm:x`):
resolve a Vendor (pack if the input matches one; else `custom_<slug>`), derive
targets (OpenAPI → exact local poll; GitHub repo → release poll; changelog/docs
→ Context.dev page monitor, semantic), write config, create Context.dev
monitors idempotently (keyed on url in cache), run an initial poll to seed
state. `--test` prints what would be watched and the last 3 releases /
extracted items without persisting.

**Watch** (`autoshim watch --once`): for each active target, `ChangeSource.poll`.
Emits `VendorChange[]`, writes each to `.autoshim/changes/`, dedupes by
`fingerprint`, drops ignored ones. Then runs impact + heal for each change
unless `--no-heal`.

**Understand**:
- OpenAPI: differ (§6 below) → `SpecDiff` → classification by PRD §10 rules;
  `breaking_confidence` = 0.95 for structural breaks, 0.7 deprecation, 0.5
  additive.
- GitHub release: release body → Claude with the generic extract schema (PRD §9)
  → one `VendorChange` per item with `impact ≠ docs_only`; confidence from the
  extraction.
- Page (Context.dev): on detected change, call `web-extract` with the pack's
  schema or the generic schema → same path as release notes.
- `fingerprint = sha256(vendor_id + sorted entity names + classification + normalized title)`.

**Impact** (`autoshim impact <change-id>` / automatic): build or load the file
index (imports of known packages, string literals matching `/v\d+/...` or
vendor hostnames, client constructors from pack `import_patterns`); search for
change entities, spec-diff paths, package ids; score per PRD §12.2;
`patchable` per §12.3. Skip dirs per PRD. Index invalidated when
`git rev-parse HEAD` changes.

**Heal** (`autoshim heal [--dry-run]`): if `patchable` and classification ∈
{breaking, deprecation} (additive → no PR; PRD §23), run the agent with:
VendorChange, SpecDiff, contents of hit files only, pack `heal.notes`. Output
contract: a JSON list of `{path, newContent}` limited to hit files (+1 for an
import fix), plus a PR-body "What I changed" list and TODO markers where unsure.
Safety caps: ≤20 files, ≤400 diff lines, no new deps, no lockfile edits → else
fall back to Issue. Rules from PRD §13.2 go in the system prompt verbatim.

**Publish**: branch `autoshim/<vendor>/<fingerprint8>`. One open Autoshim PR per
(repo, vendor): if one exists, push a new commit to its branch and update the
body with a "Superseded change" section rather than open a second PR. Two
different vendors on the same day → two branches, two PRs (quality bar #5).
No hits but breaking/deprecation → Issue `[autoshim] <Vendor> <title>` with
excerpt + URLs. Draft PR title/body/labels exactly per PRD §13.2. `--dry-run`
prints the unified diff and the PR body and touches nothing.

## 6. OpenAPI differ

Own implementation in TS (no Go binary, no stale `openapi-diff`). Requirements:

- Accept OpenAPI 3.x and Swagger 2 (normalize 2 → 3 shape for the parts we
  diff), JSON or YAML.
- **No full dereference.** The GitHub REST spec (quality bar #1) is ~10 MB with
  deep `$ref` graphs; naive dereferencing explodes. Diff structurally:
  compare `paths`×methods, parameters, request/response schemas at the `$ref`
  level; resolve refs lazily only inside subtrees whose serialized form differs.
  Compare `components/schemas` by name independently and attribute schema
  changes to the operations that reference them.
- Detect: paths added/removed/renamed (path+method similarity > 0.9), operations
  added/removed, params added-required/removed/renamed/type_change, properties
  same, enum values removed, `deprecated: true` flips, security scheme changes.
- Output PRD §10 `SpecDiff` verbatim, plus derived `entities[]`.
- First test: two real revisions of `api.github.com.json` from the
  `github/rest-api-description` history; must finish in < 5 s and produce a
  sane diff. Second test: fixture spec with one property removed → exactly one
  `removed` change, classification `breaking`.

## 7. Packs

`packs/_template.yaml` and the PRD §7 YAML shape verbatim, with one addition:
`heal.notes` (free text handed to the agent, e.g. "Stripe pins API version via
`apiVersion` in the client constructor"). Loader validates with zod; a pack
test asserts every pack parses and every `packages` entry is unique across the
registry. Seed packs: stripe, github, openai, shopify, slack.

## 8. CLI surface (SP1)

```
autoshim init                       # detect languages, write .autoshim/config.yaml, run discover, offer to add pack vendors
autoshim discover [--json]
autoshim add --openapi <url> | --changelog <url> | --docs <url> | --repo <o/n> | --package <eco:name> [--name X] [--test]
autoshim watch --once [--no-heal] [--vendor id]
autoshim simulate --vendor id --openapi <path-or-url>   # inject a new spec version (demo + tests)
autoshim impact <change-id>
autoshim heal [<change-id>] [--dry-run]
autoshim ignore --fingerprint <fp> | --entity <name>
```
Env: `GITHUB_TOKEN` (publish), `ANTHROPIC_API_KEY` (extract + heal),
`CONTEXT_API_KEY` (page targets). Every command works in `--dry-run`/read-only
form without any key so the pipeline can be inspected before spending money.

## 9. Error handling

- Missing key → stage reports `skipped: needs X`, never throws; pipeline
  continues for other targets.
- Spec fetch fails / unparsable → target marked `error` in state with reason;
  no change emitted; next run retries.
- Agent returns edits outside allowed files, or over caps → discard edits, file
  Issue with the diff the agent attempted (PRD principle 7: fail loud).
- PR creation fails after branch push → print branch name and body so the user
  can open it manually.

## 10. Testing

- **Unit (vitest):** discover parsers (fixture manifests per ecosystem), pack
  loader, differ (fixture pairs incl. GitHub spec), classifier, fingerprint
  stability, impact scorer on fixture repos (`fixtures/repos/js-stripe`,
  `fixtures/repos/py-openai`), PR/Issue body rendering, safety caps.
- **Integration:** `simulate` end-to-end against a fixture repo with a fake
  `Publisher` and a recorded agent response — asserts branch name, file set,
  body. Quality bars #1–#5 each get a named integration test; #3/#4 mock
  Context.dev/registry HTTP.
- No live network in tests; Context.dev + Anthropic + Octokit behind interfaces
  with fakes.

## 11. Explicitly out of scope for SP1

Hosted API, worker queues, GitHub App, webhooks, dashboard, notifications,
slash commands (`/autoshim ignore` on PRs), multi-repo fanout, pricing, Go/Ruby
healing, deterministic healer strategies 1–2, sitemap/extract Context.dev
targets, the remaining 15 packs.
