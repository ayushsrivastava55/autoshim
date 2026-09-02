# Detection layer redesign research (2026-09-02)

Inputs: YC RFS "Self-Maintaining APIs" verbatim; competitor scanner mechanics (mendapi concepts
[AGPL — concepts only], Renovate managers, apidrift/BreakShield claims [unverified marketing]);
tooling landscape (ast-grep, tree-sitter, semgrep/OpenGrep, ts-morph, GritQL, Jedi/Pyright/LibCST,
Aider repo-map). Two research agents + direct RFS fetch.

## The RFS's own framing (verbatim quotes)
- "over 30% of our service downtime [at AWS] was due to external api/package changes going unnoticed"
- "an agent should scan customer codebases, identify affected usages, and open a PR with the fix"
- "Agentic coding tools like Claude Code, Devin, Greptile prove that developers and enterprises
  are willing to give codebase access to external tools"
→ The market thesis is agent-framed. A regex-only impact scan is below the bar.

## What the research established
1. **mendapi's cheap tricks are genuinely good** (concepts): provider signature registry
   (imports + API hostnames + env-var prefixes per vendor, language-keyed); a lexical
   comment/string-masking pre-pass (kills the "changelog quoted in a comment" false-positive
   class); two-tier confidence (vendor-touched vs the SPECIFIC changed symbol touched);
   monorepo sub-API filtering (AWS S3 user not flagged for DynamoDB change); prerelease gating.
2. **ts-morph is the real thing behind competitors' AST claims** (JS/TS only): resolves aliased
   imports, destructured calls, wrapper forwarding — IDE-grade find-references. apidrift/
   BreakShield technical claims are unverified marketing, but the technique is sound.
3. **ast-grep (@ast-grep/napi, MIT)** is the best embeddable structural layer: native Node
   bindings, JS/TS + Python via tree-sitter, catches multi-line/chained/formatted call shapes;
   needs an import-alias pre-pass (structural, not semantic).
4. **semgrep is a trap**: cross-file analysis (the wrapper-detection part) is paywalled; engine
   not npm-embeddable. OpenGrep fork exists but cross-file roadmap unverified.
5. **The proven hybrid is "static candidates → LLM confirms"** (Aider repo-map blueprint), not
   LLM-reads-everything. No established product does agentic vendor-API-usage scanning as a
   bounded task — greenfield differentiation.
6. **Renovate's manager pattern** = detection decoupled into (file targeting, extraction
   strategy, one declarative output record) — any detection mechanism feeds one pipeline.

## Proposed 4-layer detection pyramid (replaces plan Task 11's regex index)
- **L0 Census** (built, Task 4): manifests → which vendors exist. Unchanged.
- **L1 Signature scan** (upgrade of the old regex plan): per-pack signature registry (imports,
  API hostnames, env-var prefixes — pack schema gains `hostnames`/`env_prefixes`), lexical
  comment/string-masking pre-pass, then a SYMBOL tier: grep flagged files for the specific
  entities in the VendorChange (our differ emits exact symbols — stronger grounding than
  mendapi's changelog-text extraction). Sub-API filtering + prerelease gating. All-language,
  zero deps, milliseconds.
- **L2 Structural/semantic pass**: @ast-grep/napi structural matching (JS/TS + Python) for
  call-site spans; ts-morph semantic resolution for JS/TS (aliases, destructuring, one-hop
  wrappers). Python semantic sidecar (Jedi/Pyright) deferred to v1.1.
- **L3 Agent triage (Claude)**: runs ONLY when a breaking change lands and only over L1/L2
  candidates + a tree-sitter repo-map of flagged files. Confirms/rejects ambiguous hits,
  hunts what static can't see (raw HTTP behind helper modules, dynamic dispatch), emits the
  final ImpactReport with per-file reasoning. Bounded cost by construction.
- **Confidence = layer agreement**: symbol+structural+agent-confirmed ≫ signature-only.
  reason strings carry which layers agreed (feeds PR-body evidence).

## Plan impact (pending user approval)
- Task 11 (impact) splits: 11a signature scan + masking pre-pass; 11b ast-grep/ts-morph pass;
  11c agent triage integrated with the healer's flow. Pack schema micro-extension in a small PR.
- New deps ruling needed: @ast-grep/napi, ts-morph (both MIT).
- Sequencing: detection is Phase 4 territory; Phase 3 (watchers) is orthogonal and unblocked.
