# Saved local GitHub REST watch

Approved milestone: save one TypeScript consumer, explicit baseline/API version and one local fixture or allowlisted public GitHub REST OpenAPI source. Repeated caller-driven checks compare the pinned baseline to current upstream and rescan consumer code, even if upstream bytes are unchanged. No installed scheduler, hosted service, uploads, repairs, alerts or credentials.

Options considered: hosted jobs add auth/operations before usefulness; a generic URL watcher adds SSRF and integration breadth; a local saved configuration plus a strict GitHub raw-source allowlist is the smallest repeatable product. Choose local state with atomic writes, single-run locking, bounded history and content-addressed snapshots. Keep baseline fixed; never silently accept breaking changes by advancing it.

State has immutable config, baseline snapshot, latest report and bounded run/finding history. Finding fingerprints omit timestamps/line offsets so repeated evidence does not become a new alert. Current active findings and exit status remain visible on repeated runs. Incomplete analysis is not green. Invalid sources, mismatched asserted versions, fetch/parse/read failures are recorded as error runs without advancing successful upstream state.

Public sources: HTTPS only, exact raw.githubusercontent.com host and github/rest-api-description repo/path, no credentials/query/fragment/ports, no redirects. 15 MiB streaming limit and 20s deadline. No ambient token/cookie headers. Local source files are explicit caller inputs. Ordinary state symlinks are rejected. Caller chooses state directory; parent directory must be trusted. No claim of OS sandboxing or malicious filesystem-race hardening.

Documentation followed before code: Node official globals fetch/AbortController/AbortSignal, filesystem fsPromises.open and FileHandle APIs/flags, crypto createHash; installed Commander README required options/commands/async actions and TypeScript AST declarations; installed Vitest tests/API. https://nodejs.org/api/globals.html#fetch https://nodejs.org/api/fs.html#fspromisesopenpath-flags-mode https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm-options

Acceptance: positive/negative/incomplete checks, unchanged dedupe, consumer edits with unchanged upstream, bounded history, recorded failures, unsafe URL/redirect/size/time rejection, corrupt config/state rejection, no consumer execution, and one real public-source check with honest coverage. Same-file statically proven class/factory transport support may follow; external factories remain unknown. No tested repair PR is claimed.

## Recorded verification

Engine/CLI implemented with watch init/check/history/demo. Offline CLI positive: exit 1, new findings 1 then 0, active confirmed result retained; negative: exit 0 twice; incomplete: exit 2 twice, new issues 2 then 0. All histories contain two runs. Demo new-finding counts 1 then 0. Consumer edits are rescanned even for identical upstream bytes; incomplete coverage no longer resolves prior findings (RED→GREEN regression). Errors retain last successful hash. Storage/history/locking/tampering, unsafe URL/redirect/header/stream/deadline boundaries are covered by tests.

Real public source: https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json . Two successful reads of identical hash f3efa055b46b43f5f133ecf792a36a7f50cf8a4378cbd177390bc2bf8c6097cd, info.version 1.1.4. Pinned baseline 945021ca606a4884b0cae7bcad2d28c01619b332. Constructed supported consumer recognized the synchronous SBOM deprecation as possible; no endpoint removal or deployed failure claimed. Overall incomplete with 61 coverage issues, exit 2. First run: 1 new finding, 61 new issues; second: 0 new findings, 0 new issues, upstreamChanged false. Source and consumer API applicability remain user asserted (2022-11-28); schema info.version is distinct. Temporary proof directory: $TMPDIR/autoshim-watch-public-fsztj3ql.

Same-file statically proven class fields/constructor assignments and simple top-level zero-argument factories are supported. Opaque imported createOctokit factory in the public toolkit remains unknown. Class/member reassignment is rejected. No cross-file factory inference or repair loop was added.

A transient Mac execution connection outage delayed manual checks; it recovered. No persistent scheduler, credential, deployment, third-party write, paid API or license change occurred.

## Concrete next milestone

A repair proposal should start with one migration recipe and proven affected usage, prepare an isolated local patch, run an inspected bounded validation command, and show the patch/test evidence. Current deprecation evidence alone does not prove changed field consumption or a working replacement. Do not label a proposal as a tested fix until validation passes. External PR creation/publication and arbitrary consumer scripts are outside this milestone.
