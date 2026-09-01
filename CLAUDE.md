# Autoshim — engineering rules

Autoshim watches third-party vendor APIs (OpenAPI specs, changelogs, GitHub releases) and opens draft fix PRs before production breaks. "Renovate for the APIs you don't control."

Authority chain: spec (`docs/superpowers/specs/2026-08-26-autoshim-sp1-cli-core-design.md`) > plan (`docs/superpowers/plans/2026-09-01-autoshim-sp1.md`) > this file.

## Non-negotiables

1. **Docs before code — every implementation, every time.** Before writing or changing ANY code that uses an external API, SDK, or library, read the current documentation first — never code from memory:
   - Context.dev → `docs/references/context-dev/llms-full.txt` (full mirror; index in `llms.txt`) or the live page
   - Anthropic SDK → the claude-api skill; Octokit, MCP SDK, vitest, commander, zod → their current README/docs
   - Cite in the task report WHICH doc section you followed. Code written from a recalled API shape is a defect even if it happens to work.
2. **Production bar, no patch code.** No TODO-stubs left behind, no swallowed errors, no `any` escapes, no commented-out code, no quick hacks "to make the test pass". Typed errors, explicit degradation paths (missing key → reported `skipped`, never a throw), every external call behind an injected interface with a fake in tests.
3. **Explore before committing.** Any task with design freedom (not pure transcription) starts by enumerating 2–3 real approaches with trade-offs in the task report, then picks one with a stated reason.
4. **Small PRs.** One plan task = one PR. Never bundle unrelated changes.
5. **Tests are behavior, not mocks.** No live network in tests; the one exception is the net-gated GitHub-spec perf test (`AUTOSHIM_NET_TESTS=1`).
6. **Zero-bug discipline from the start.** Every function ships with: tests written first (RED→GREEN evidence), every error path exercised (bad input, network failure, missing key, unparsable data), boundary cases named and tested (empty, one, many, huge, unicode, concurrent), and a self-review of the diff before commit. A bug caught in review is a process failure to note in the ledger, not just a fix.
7. **Optimize every piece of code.** Know each function's input scale and write for it: no accidental O(n²) over spec paths or repo files, fast-path equality checks before deep comparison (stringify-compare before recursion), lazy `$ref` resolution, stream/iterate instead of buffering when inputs can be large (10MB specs), cache what is re-read (file index), single-pass where a single pass suffices. Clarity is not the casualty: prefer the clear O(n) over the clever micro-optimization; flag any deliberate trade-off in the task report.
8. Strict TypeScript, ESM with `.js` import extensions, Node >= 20, Apache-2.0.

## Working with the user

Discuss before big moves. Present plans and get explicit approval before execution phases. The user merges PRs.
