# Isolated SBOM migration proposal

Initial approved scope: one deterministic local proposal tested in an owned fixture. The user subsequently required real integration; public no-token GitHub generation/poll/download was then authorized and completed. No automatic customer edits, customer script execution, credentials or external PRs.

Official contract reviewed 2026-10-04: https://docs.github.com/en/rest/dependency-graph/sboms?apiVersion=2026-03-10 and https://github.blog/changelog/2026-05-12-synchronous-sbom-api-deprecated/ . Generation uses GET /repos/{owner}/{repo}/dependency-graph/sbom/generate-report, returns 201 with sbom_url. Fetch-report returns 202 pending, 302 ready with temporary download location. Synchronous route closes November 13, 2026. Endpoint generation is GET, not an assumed POST. Download is SPDX JSON rather than the old sbom envelope.

Approaches: transform arbitrary SDK wrappers requires cross-file auth/redirect provenance; blindly change endpoint preserves the wrong response contract; a strict raw-fetch function recipe plus a separate safe helper is small and inspectable. Choose the last. Match only a global literal API fetch in a two-statement async function returning (await response.json()).sbom, with explicit 2026-03-10 header and no custom transport/options. Others report proposal unavailable. This is a recipe boundary, not a recommendation to broadly upgrade API versions.

Temporary download hosts are not enumerated by the official API docs. A reviewed exact hostname allowlist is required; no invented production host. Demo uses a fixture-only hostname with mocked transport. API auth stays on api.github.com; download requests omit auth/cookies and refuse redirects. Poll URLs must remain on the exact repo's GitHub API fetch-report path. Total deadline, poll count and byte limits are enforced. No credential/header values in diagnostics.

Patch and previews are written to a new private directory outside the consumer repo. General proposal generation parses but never executes customer code. Validation executes only an owned constant fixture and the generated trusted helper with mocked fetch. Report mock validation distinctly from live GitHub integration. No automatic git apply.

Docs used before code: official GitHub SBOM endpoint contracts; installed diff README createTwoFilesPatch; installed TypeScript declarations createSourceFile/node guards/transpileModule; Node fetch/AbortController filesystem APIs as recorded in watch milestone; installed Vitest patterns. The interrupted optional watch ledger append was not present; prior 159-test result remains valid and is now recorded here. No optional Markdown rerun proof directory persisted.

## Initial offline verification

2026-10-04: Runtime and generator tests were written first; each initially failed collection for its missing module, then passed after implementation. CLI tests likewise failed before its module existed.

Implemented core `sbom-runtime.ts` and `sbom-proposal.ts`, CLI `proposal.ts` and `proposal sbom/demo` commands, corresponding tests and exports. No dependencies or license changes for this milestone. Outputs are private new directories, not consumer edits. An imported-factory SDK consumer remains unavailable. No generalized repair or automatic applicability inference.

Initial full `pnpm build` passed. Initial `pnpm test`: 178 passed, one optional real-spec performance test skipped, across 14 test files. Added 20 behavior tests: 13 runtime, four generator, three CLI. The CLI demo's isolated Node process also executes four mock tests, all pass, zero skips. These four nested checks are distinct from Vitest's test count. No live service integration performed.

Actual CLI evidence retained outside the project:

- `$VALIDATION_WORKSPACE/sbom-proposal-demo`: `proposal.patch`, `preview/`, `validation.json`, owned executable validation files. CLI exit 0, mock_validated, four passing tests.
- `$VALIDATION_WORKSPACE/sbom-proposal-generated`: generic proposal exit 0, validation not_run. `git apply --check` passed against the owned original consumer, without applying changes.
- `$VALIDATION_WORKSPACE/sbom-proposal-unavailable`: 2022-11-28 fixture exit 2, unavailable with explicit-version reason, no patch.

Reproduce using a fresh `--out` directory: `node packages/cli/dist/index.js proposal demo --out /tmp/new-autoshim-sbom-demo`. Build first. Existing outputs are never overwritten. Full workspace tests are offline by default.

Review caught and fixed: macOS `/var` versus `/private/var` output-parent aliases initially bypassed consumer containment; canonicalize the existing output parent and regression-test it. Explicit TAP formatting stabilizes recorded demo evidence across Node versions. Whole-flow timeout now clears pending delay timers as well as aborting requests; streaming size limits do not trust content-length. Final diff whitespace check passed. Unrelated `.DS_Store` and `content/` preserved.

Limits: narrow two-statement raw-fetch pattern only; explicit 2026-03-10 version only; caller-reviewed exact download hosts (DNS/parent directories are trusted); source parse rather than full type-checking; minimum SPDX shape validation rather than full SPDX schema. Generic proposals remain unvalidated. No production SBOM download host was guessed.

## Real public integration completed

The user explicitly rejected mock-only delivery. Reviewed official GitHub SBOM documentation again: generation and fetch-report both support public resources without authentication. Confirmed `octokit/rest.js` public with actual repository metadata HTTP 200, then requested real generation HTTP 201 and polled HTTP 302. GitHub's HTTPS response supplied the exact Azure host `dgpproduction.blob.core.windows.net`; reviewed it and used that host only for this validation, without making it a product default or saving signed download URLs.

Executed the actual generated preview for an owned consumer targeting this public repository. The transport wrapper only recorded metadata and delegated to native fetch, returning unmodified real Responses; it did not fabricate responses. Checked the original/preview/helper hashes and matched the helper to the current trusted source before compilation/execution. No customer code ran.

First attempt reached generation 201, poll 302 and download 200 but body consumption exceeded the 20-second deadline, producing an unsanitized abort error. Preserved that failed attempt in `sbom-live-proposal/live-validation.json`. Independent bounded download diagnostic retrieved 1,288,937 raw bytes in 13.116 seconds. The exporter uses document name `com.github.octokit/rest.js` and generated SPDX element IDs, rather than the illustrative IDs in GitHub's example. The live validator now identifies the repository through its GitHub package URL, not a hardcoded example SPDX ID.

Fixed the actual runtime body-error path: aborts report the whole-flow deadline; other body transport errors are sanitized. Added two behavior regressions, observed one failing before correction, then green. Raised the configurable default total deadline to 60 seconds (maximum remains 120 seconds), retaining poll-count and 15MiB byte caps. No endpoint/auth semantics changed.

Regenerated and executed the exact proposal preview with the corrected helper. Live run succeeded 2026-10-04 at 22:19:18–22:19:37 Asia/Calcutta (16:49:18–16:49:37 UTC), with real HTTP sequence:

- GET `https://api.github.com/repos/octokit/rest.js/dependency-graph/sbom/generate-report`: 201.
- GET the exact repository fetch-report URL returned by GitHub: 302. The report was already ready; no 202 occurred in this run.
- GET the temporary approved-host download URL: 200. Redirect handling remained manual; credentials omitted; no Authorization/Cookie headers sent. Temporary signed query/path omitted from evidence.

Returned SPDX-2.3, SPDXRef-DOCUMENT, CC0-1.0; 1,764 packages and 3,480 relationships, with the expected public GitHub repository purl. Stored normalized document is 1,636,755 bytes, SHA-256 `c7d5a966b692f8b92436f83baa663f3db9aaf280f0b863279c04bd02c8ee57ae`. Checked required document fields, arrays, repository identity and helper bounds; this is not full SPDX schema certification.

Deliverables under `$VALIDATION_WORKSPACE/sbom-live-proposal-v2/`: `proposal.patch`, `proposal.json`, `preview/`, `live-validation.json`, `sbom.spdx.json`, `owned-live-execution/`. Reproducible owned runner: `$VALIDATION_WORKSPACE/sbom-live-validation-v2.mjs` (requires a fresh output directory and regenerated proposal; existing files are never overwritten). Separate metadata probe and failed/diagnostic evidence preserved in the task directory.

Current checks after the runtime fix: `pnpm build` passes; `pnpm test` has **180 passed, one optional real-spec performance test skipped**, across 14 files. These are regression counts, not integration proof. The separate real GitHub run is the integration proof for this public repository case only. Generic proposal manifests remain `not_run`; the explicit live evidence binds this one tested preview and helper by SHA-256. No claim of arbitrary SDK/wrapper, authenticated/private-repository or pending-202 integration coverage.

Publishing note: `$VALIDATION_WORKSPACE` and `$TMPDIR` denote local evidence directories; raw downloads and private state are excluded from the repository. The public response metadata, source/helper hashes and document summary are retained in [docs/evidence/sbom-live-public.json](evidence/sbom-live-public.json).
