# Code-study & literature synthesis (2026-09-01)

Sources: shallow clones of oasdiff, openapi-changes+libopenapi, mendapi (AGPL — concepts only,
no code reviewed for reuse), renovate, changedetection.io (in scratchpad, not this repo);
academic/industry literature sweep. Three research agents, findings condensed.

## What the mature differs taught us (oasdiff, libopenapi)
1. **Checks are data**: one rule per file with a stable string id (`response-property-became-required`),
   metadata (direction, area, effect, guards), severity DERIVED from direction×effect
   (narrowing a request or widening a response breaks), guards nullifying impossible cases
   (readOnly prop can't appear in a request).
2. **Two layers**: structural diff tree first, interpretation/checks pass second — one diff
   feeds raw/breaking/changelog outputs.
3. **Neither tool does rename detection.** Key-matched delete+add only. Fuzzy matching is
   poor-ROI; we drop it from v1 (the `renamed` kind stays in the type for the future).
4. Cycles: visited-set of `$ref` names per traversal side; circular refs equal iff same ref name.
5. Memoize schema-pair diffs **keyed by direction** (same pair means different things in
   request vs response).
6. allOf: explicit upfront flatten pass, plus 3.0-vs-3.1 nullable-convention normalization
   (`nullable: true` ≡ `type: [X, "null"]`).
7. Negotiated response fields (media types, statuses, headers the client selects): removal
   is breaking — reverse of normal response polarity. Non-success status changes are
   noise-guarded.
8. Sunset/deprecation is a *governance* finding class (removed-before-sunset) distinct from
   wire breakage.
9. Keep source line/column on change nodes early (future PR-comment placement).

## What the literature taught us
- Most frequent real-world breakers (ranked): renames/moves, silent removals without
  deprecation, auth changes, semantic-only changes. Providers routinely drop endpoints
  without deprecating (RADA, ICSME 2020, 2,224 specs).
- Spec drift is real: vendor white paper claims ~75% of production APIs vary from published
  specs (unverified methodology — hedge). Implication: "observed drift" is a future
  detection category; near-term it justifies changelog+release watching alongside spec diff.
- Academic white space: LLM auto-repair exists for package deps (Byam 2025, DepRepair 2026)
  but NOT third-party web APIs — citable YC gap.
- Incident ammo: Google Maps 2018, Facebook Graph 2018, Shopify REST deprecation 2024-25.
  Stripe's date-versioning is the best-practice contrast.

## Product recon
- mendapi: v0.5.6, 1 star, July 2026, AGPL. Pipeline watcher/scanner/fixer, deterministic
  migration packs, `--apply` gate, MCP server, "no-network-in-scanner enforced by tests"
  as a trust signal. Validates the thesis; not yet an incumbent.
- "Dependabot for APIs" is already a cliché among sub-50-star 2026 clones (contractbot,
  apisentry, …). Nobody >50 stars does vendor-API fix PRs. Category pre-breakout.
- Renovate: abstract-class-per-datasource plugin model; preset reference syntax
  (`github>org/repo:name#tag`); branch dedupe via prefix+topic (+`branchPrefixOld` for
  renames); PR body as toggleable named sections; concurrency limits as safety valves.
- changedetection.io: Watch→Tag→Global config override chain; Apprise for provider-agnostic
  notifications.

## Adopted NOW (plan amendments, Task 6 + Task 16)
1. Drop fuzzy rename detection from v1 (delete+add like the incumbents).
2. Stable rule ids on every finding (`OperationChange.rule?: string`).
3. Direction-aware classification with readOnly/writeOnly guards and negotiated-field polarity.
4. Upfront allOf flatten + nullable normalization in the spec loader/differ.
5. Direction-keyed schema-diff memoization; ref-name cycle guards.
6. Task 16 gains a "no network primitives outside sources/" enforcement test (mendapi-style
   verifiable trust claim, cheap to add).

## Parked for later (ledgered, not lost)
- Observed-drift detection (live traffic vs spec) — SP3+ hosted differentiator.
- Renovate-style PR-body sections, Watch→Group→Global config chain, preset syntax for the
  packs registry, concurrency limits — SP2/SP3 when multi-vendor scale makes them real.
- Governance findings (removed-before-sunset) — v1.1 of the differ.
- Semantic-only change detection — research-grade, future.
