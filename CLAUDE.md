# Autoshim — engineering rules

Autoshim watches third-party vendor APIs (OpenAPI specs, changelogs, GitHub releases) and opens draft fix PRs before production breaks. "Renovate for the APIs you don't control."

Authority chain: spec (`docs/superpowers/specs/2026-08-26-autoshim-sp1-cli-core-design.md`) > plan (`docs/superpowers/plans/2026-09-01-autoshim-sp1.md`) > this file.

## Non-negotiables

1. **Docs before code.** Before writing or changing ANY code that calls Context.dev, read the relevant section of `docs/references/context-dev/llms-full.txt` (full mirrored docs; index in `llms.txt`) or the live page — never code their API from memory. The same discipline applies to the Anthropic SDK (claude-api skill), Octokit, and MCP SDK: verify the current shape, then write.
2. **Production bar, no patch code.** No TODO-stubs left behind, no swallowed errors, no `any` escapes, no commented-out code, no quick hacks "to make the test pass". Typed errors, explicit degradation paths (missing key → reported `skipped`, never a throw), every external call behind an injected interface with a fake in tests.
3. **Explore before committing.** Any task with design freedom (not pure transcription) starts by enumerating 2–3 real approaches with trade-offs in the task report, then picks one with a stated reason.
4. **Small PRs.** One plan task = one PR. Never bundle unrelated changes.
5. **Tests are behavior, not mocks.** No live network in tests; the one exception is the net-gated GitHub-spec perf test (`AUTOSHIM_NET_TESTS=1`).
6. Strict TypeScript, ESM with `.js` import extensions, Node >= 20, Apache-2.0.

## Working with the user

Discuss before big moves. Present plans and get explicit approval before execution phases. The user merges PRs.
