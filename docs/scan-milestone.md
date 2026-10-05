# Local GitHub REST scan milestone

Approved scope: local TypeScript consumers and supplied baseline/target OpenAPI snapshots.

Approaches considered: regex request matching is small but mistakes comments and multiline calls; TypeScript AST matching uses the compiler already installed and distinguishes calls from prose; a full type-checker/SDK schema map handles wrappers but expands scope and maintenance. Choose bounded AST matching, no type-checker or network.

Evidence proves a request targets a removed operation between supplied snapshots, conditional on runtime execution and the asserted API version. Changed field/schema matches are only possible impact; endpoint matching never proves field consumption. Missing API-version assertion, unsupported SDK/dynamic patterns, parse errors, invalid refs, unsupported schema constructs, omitted error-response changes, or read limits yield incomplete coverage.

Initial patterns: absolute api.github.com fetch literals and direct @octokit/request or imported Octokit instance request("METHOD /route") calls. Dynamic paths, SDK rest methods, wrappers and aliases beyond import aliases are unsupported. No code upload, credentials, paid APIs, repair, hosting, or publishing.

Documentation used: installed Commander README Required option, parse/parseAsync, Display error; installed TypeScript typescript.d.ts createSourceFile, forEachChild and node type guards; existing Vitest tests/API and installed README.

## Validation ledger

Existing baseline: 99 tests passed, optional real GitHub spec test skipped. New tests cover line evidence, unchanged operations, comments, foreign hosts, API version uncertainty/conflicts, fields versus endpoints, syntax errors, dynamic routes/options, SDK method gaps, import aliases, shadow/reassignment/destructured bindings, malformed/unsupported specs, formatting, root/overlapping paths, Unicode/multiple files, filesystem limits, manifests and symlinks.

RED → GREEN regressions reproduced and fixed: explicit version conflicts and route overrides initially yielded clean/confirmed outcomes; imported fetch and API URL wrappers initially escaped uncertainty reporting; destructured binding shadows, invalid calendar dates and the root endpoint needed fixes. Test scaffolding initially had quoting/brace syntax errors, corrected before behavior validation.

Manual built CLI checks: positive fixture → confirmed removal at app.ts:2, exit 1; negative → no_detected, exit 0; dynamic → incomplete, exit 2. JSON, terminal and Markdown outputs inspected. Runtime uses already-installed TypeScript 5.9.3, declared as a core dependency; offline install downloaded zero packages. No consumer code is executed.

Current scope limits are in README. Optional real GitHub snapshot performance test remains unrun; synthetic fixtures prove pipeline behavior, not a real-world GitHub compatibility catch. Labels and API version applicability are user asserted.

## Independent review and public-data validation (2026-10-04)

Reproduced and fixed four additional false-clean cases with regression tests: shorthand/computed/duplicate request option keys, custom Octokit transport defaults, existing parameter requiredness changes and request-body requiredness changes. Unbound class/factory request receivers now explicitly report incomplete coverage. Referenced/path-level parameters, referenced bodies/responses, unsupported validation keywords and operation-security changes are also surfaced conservatively.

Final build and diff whitespace check pass. `AUTOSHIM_NET_TESTS=1 pnpm test`: 137 passed, none skipped. Real GitHub spec diff performance test passed (about 0.95s in the full suite). Normal suite keeps the optional real-spec test gated.

Public snapshots downloaded read-only from revision-pinned raw GitHub URLs; bytes matched the existing ignored cached fixtures exactly:
- baseline: github/rest-api-description@945021ca606a4884b0cae7bcad2d28c01619b332, descriptions/api.github.com/api.github.com.json; 11,647,916 bytes; SHA256 b585efda47fe3d637d630d973ef67bd19e06758d1c9fdab2dc393050cdb1a5d4
- target: github/rest-api-description@92dc700c26e51bdb084f990f9c56a1815e5ec58a, same file; 12,938,766 bytes; SHA256 aec81d8b95d6eb5af61ef8d28c4f54a6b893594dded7d5bc60134d4d73c622d7

A constructed realistic supported consumer example uses direct @octokit/request for repository metadata and synchronous SBOM, plus fetch /user. These files were parsed, not executed. Three requests recognized; one possible operation-deprecated finding at app.ts:4 for GET /repos/{owner}/{repo}/dependency-graph/sbom. That endpoint exists in both specs; target marks deprecated:true. No removal or deployed failure is claimed. Full report outcome incomplete (50 coverage issues), exit 2, because full public specs contain unsupported composition/constraints and other unmodeled changes. Report: /tmp/autoshim-real-report.json.

Public https://raw.githubusercontent.com/advanced-security/github-sbom-toolkit/main/src/sbomCollector.ts downloaded read-only. Verified synchronous SBOM request at line 484 in fetched source; uses this.octokit.request with createOctokit factory, outside supported bindings. Zero requests recognized, no inferred findings, incomplete with explicit unbound receiver issues (57 total including global spec issues), exit 2. Report: /tmp/autoshim-sbom-report.json. This is a public technical validation candidate, not a customer or evidence of a production vulnerability.

Privacy review: normal child symlinks are skipped/reported, excluded dirs are not read, only source/manifest/supplied spec files are read; reports do not include source snippets or auth/header values. This is bounded static traversal, not a claim of TOCTOU-hardening against concurrent malicious filesystem changes. Scanner performs no HTTP calls and never executes consumer code. Public snapshot/source downloads were separate explicit verification commands. No push, publication, license changes or third-party writes. Commercial readiness remains unverified; global coverage warnings and unsupported class/factory SDK patterns are material constraints.
