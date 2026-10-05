# Autoshim

Find third-party API changes that may affect your code. The first working slice is a **local GitHub REST scan for TypeScript consumers**: compare two supplied OpenAPI snapshots and map changed operations to direct request call sites.

Status: pre-alpha. The detection core, local scan and saved caller-driven watch work. Historical feed backfill, autonomous repair, draft PR publishing, MCP and hosted services are not implemented. Nothing is published to npm by this change.

## Try the saved-watch demo

After `pnpm install` and `pnpm build`, this offline demo creates fresh private state and checks twice:

```sh
demo_root=$(mktemp -d /tmp/autoshim-demo.XXXXXX)
node packages/cli/dist/index.js watch demo --state "$demo_root/watch" --format terminal
```

The synthetic removed endpoint appears on both runs. New-finding counts are **1 then 0**. Exit 1 means a finding remains active, not that the demo crashed. Use `--format json` or `markdown`. Existing state directories are never overwritten.

## Save a real watch

```sh
node packages/cli/dist/index.js watch init \
  --state .autoshim/watch \
  --repo /path/to/typescript-consumer \
  --baseline /path/to/pinned-github-openapi.json \
  --baseline-label github-spec-known-revision \
  --source https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json \
  --api-version 2022-11-28

node packages/cli/dist/index.js watch check --state .autoshim/watch --format terminal
node packages/cli/dist/index.js watch history --state .autoshim/watch --format json
```

The date is an example of a **user assertion**, not automatic version discovery. Initial baseline and consumer/source paths are saved explicitly. Both snapshots must apply to the asserted consumer version. `info.version` is recorded as upstream schema metadata, not treated as a GitHub API-version assertion. An optional `watch check --api-version` must equal the saved version; differing declared `x-github-api-version` metadata is an error.

The baseline stays pinned. Every check fetches the source and rescans the consumer, even when the upstream hash is unchanged. Findings are fingerprinted by file, operation and change evidence, excluding line offsets/timestamps. Current findings and exit status remain visible; repeated identical evidence has zero new findings. If the consumer changes, results can change without an upstream update. Incomplete scans **never silently resolve earlier active findings**. Proven complete resolutions can reopen as new findings later.

Watch check uses the scan exit codes: 0 no detected impact, 1 active confirmed/possible findings, 2 incomplete coverage or error. Fetch/parse/read errors are recorded without replacing the last successful upstream hash. JSON includes the run, new evidence and current scan; terminal/Markdown reports show the same status. History keeps 200 runs, catalogs retain up to 5,000 finding/issue fingerprints, and storage retains the pinned baseline plus at most three recent target snapshots. Reopened or evicted catalog entries can be counted as new again.

State includes `config.json`, `state.json`, latest successful `report.json`, and content-addressed `snapshots/`. Reports contain consumer paths and schema-change evidence; keep the directory private and out of commits. `.autoshim/watch/` is ignored in this repo. State directories/files reject ordinary symlinks and use private creation modes, an exclusive run lock and atomic JSON replacement. Choose a trusted parent directory. This is not an OS sandbox or a guarantee against malicious concurrent filesystem races. A stale `.lock` must be inspected before manual removal; it is not automatically stolen. Disk/permission failures can prevent recording a run.

### Fetch boundaries and scheduling

The only public URL allowed is HTTPS `raw.githubusercontent.com/github/rest-api-description/{main-or-40-character-commit}/descriptions/api.github.com/api.github.com.json`. Credentials, arbitrary hosts/paths, query strings, non-HTTPS URLs and redirects are rejected. Fetch uses no token, cookie or authentication headers; there is a 15 MiB streaming limit and 20-second deadline. An explicit regular local file path is supported for offline fixtures. Consumer code is never uploaded or executed. Public fetches retrieve upstream schemas only.

For unattended use, a caller can run the same `watch check` command from CI or cron. **No job is installed by Autoshim.** Keep paths stable, persist the private state directory, avoid overlapping runs, and handle exit 1/2 as findings/uncertainty rather than silently ignoring them. There are no external alerts, hosted queues, billing or repair execution in this milestone.

## Run locally

Requires Node >=20 and pnpm. From this repository:

```sh
pnpm install
pnpm build
node packages/cli/dist/index.js scan \
  --repo /path/to/typescript-consumer \
  --baseline /path/to/baseline-openapi.json \
  --target /path/to/target-openapi.json \
  --baseline-label github-spec-old-revision \
  --target-label github-spec-new-revision \
  --api-version 2022-11-28 \
  --format terminal
```

Use `--format json` or `--format markdown` for structured or shareable reports. Output goes to stdout; the scanner does not modify the consumer repository, make network requests, read credentials, or execute consumer code. Omit `--api-version` when applicability is unknown; the report will be incomplete. The date above is an example, not an inferred version. Snapshot revision labels are separate from the consumer's API version; both snapshots must be appropriate for the asserted version. Always use trusted, revision-pinned snapshots. Hashes of the supplied files are included in every report.

## Evidence and outcomes

| Outcome | Meaning | Exit |
|---|---|---|
| `confirmed` | A supported direct request matches an operation removed between the supplied snapshots. Runtime execution and version applicability remain conditional. | 1 |
| `possible` | A request matches a changed operation. The scan does not prove the changed field/value is used. | 1 |
| `no_detected` | No impact found within supported patterns. This is not a compatibility guarantee. | 0 |
| `incomplete` | Dynamic/unsupported calls, unknown/conflicting version, unsupported spec coverage, unreadable sources or limits prevent a complete bounded scan. Findings are retained. | 2 |

Invalid input or unreadable snapshots also exit 2 with an error on stderr. Missing coverage never becomes a clean result. Reports include dependencies, file/line/column, operation, rule/field changes, snapshot hashes, coverage issues and limitations. `confirmed` is not proof a deployed application will fail.

## Supported consumer patterns

```ts
import { request as github } from '@octokit/request';
github('GET /repos/{owner}/{repo}', { owner: 'example', repo: 'demo' });

import { Octokit } from '@octokit/rest';
const client = new Octokit();
client.request('GET /user');

fetch('https://api.github.com/user');
fetch('https://api.github.com/repos/example/demo', { method: 'GET' });
```

Import aliases and multiline calls work. Same-file instance fields or constructor assignments initialized by an imported `new Octokit()` are supported. A top-level zero-argument factory whose only statement returns such a constructor is also supported; reassignment/custom transports invalidate provenance. Imported factories, getters and cross-file factory tracing remain incomplete. Comments and prose strings do not create findings. Analysis is syntax-based, not a TypeScript type-checker. Shadowed/reassigned bindings, route overrides, dynamic fetch URLs/options, SDK `.rest.*` methods, wrappers, variable aliases and cross-file data flow are unsupported. Explicit conflicting API-version headers produce incomplete coverage. Computed, shorthand or duplicate option keys are unsupported. SDK defaults with custom base URLs/transports are not resolved. Unproven class/factory `.request` receivers produce incomplete coverage rather than inferred matches. Terminal/Markdown control characters are escaped visibly; JSON retains exact evidence strings.

Specs with unresolved/external/escaped references, referenced/path-level parameters, referenced request bodies/responses, unsupported composition or validation keywords are reported incomplete. Existing parameter requiredness, request-body presence/requiredness and operation-security changes are also outside attribution coverage. Changed non-2xx responses and security schemes are not attributed to consumer behavior. No automatic schema/API version applicability inference is performed. The existing core has other intentional limits; this scan does not claim full OpenAPI coverage.

Traversal includes `.ts`, `.tsx`, `.mts` and `.cts`; declaration files and hidden/build/dependency directories are excluded. Symlinks are not followed. Visible JavaScript sources are reported outside coverage. Limits: 2,000 source files, 20 MiB source/manifest input, 1 MiB per source/manifest, 15 MiB per snapshot, 20,000 entries and 30 directory levels. `.gitignore` patterns are not interpreted; run against a dedicated consumer directory if it contains unrelated tools.

## Reproducible examples

The committed snapshots are **synthetic GitHub-shaped fixtures**, not claims about actual GitHub deprecations. From the repo root:

```sh
node packages/cli/dist/index.js scan --repo fixtures/scan/positive --baseline fixtures/scan/baseline.json --target fixtures/scan/target.json --api-version 2022-11-28 --format json
node packages/cli/dist/index.js scan --repo fixtures/scan/negative --baseline fixtures/scan/baseline.json --target fixtures/scan/target.json --api-version 2022-11-28 --format terminal
node packages/cli/dist/index.js scan --repo fixtures/scan/incomplete --baseline fixtures/scan/baseline.json --target fixtures/scan/target.json --api-version 2022-11-28 --format markdown
```

Expected: confirmed removal at `app.ts:2` (exit 1), no detected impact (exit 0), and incomplete dynamic route (exit 2). The fixtures are scan inputs; their consumer dependencies need not be installed.

## Validate

```sh
pnpm build
pnpm test
```

Build first: CLI filesystem tests use the compiled core package. The optional real GitHub spec performance test is gated by `AUTOSHIM_NET_TESTS=1` and local downloaded fixtures; normal tests are offline.

The prior wider product design and future plans remain in `docs/`. Current milestone decisions live in [docs/scan-milestone.md](docs/scan-milestone.md).

## License

Apache-2.0. No license changes were made.

## Isolated SBOM migration proposal

`proposal sbom` generates a separate patch and previews for one narrow TypeScript pattern: a two-statement async function with a literal global GitHub SBOM `fetch`, inline headers explicitly selecting `2026-03-10`, and `return (await response.json()).sbom`. SDK calls, wrappers, dynamic options, shadowed fetch, other API versions and complex response handling return `unavailable` (exit 2). Source remains unchanged; its hash is recorded. The general proposal is labeled `not_run`; customer code and scripts are never executed.

```sh
node packages/cli/dist/index.js proposal sbom --repo /path/to/consumer --file src/sbom.ts --out /path/to/new-private-output --download-host reviewed-download.example.com
node packages/cli/dist/index.js proposal demo --out /tmp/new-autoshim-sbom-demo
```

The output directory must be new, have an existing parent, and sit outside the consumer repository. Existing adjacent `autoshim-sbom.ts` files cause refusal. Output contains `proposal.json`, `proposal.patch` and `preview/`. No patch is automatically applied. Review the source hash, patch, helper and download destinations before use.

The recipe follows the [GitHub SBOM generation and fetch-report contracts](https://docs.github.com/en/rest/dependency-graph/sboms?apiVersion=2026-03-10): GET generation returns 201, fetch-report returns 202 while pending and 302 with a temporary download location when ready. The helper returns the downloaded SPDX document, preserves API headers only for the exact GitHub API repository report, omits credentials/auth on downloads, refuses redirects, and bounds polls, total duration and body size. The synchronous endpoint [closes November 13, 2026](https://github.blog/changelog/2026-05-12-synchronous-sbom-api-deprecated/).

GitHub's API docs do not specify a fixed download hostname. `--download-host` requires an exact allowlist reviewed by the caller; the example hostname above is a placeholder. Direct IP, localhost/local/internal, credentials, non-HTTPS URLs and unexpected poll paths are refused. Approved DNS names remain caller-trusted; this is not a DNS-resolution sandbox. Filesystem parent directories are also trusted.

`proposal demo` uses an owned source fixture and `downloads.example.test` exclusively with mocked transport. It produces a patch plus `validation.json` with hashes and four actual Node test results. Only that owned fixture and the trusted helper are executed. `mock_validated` proves the mocked flow, not real GitHub service integration or compatibility with arbitrary customer code. No live authenticated API call, scheduler, PR or deployment occurs.

A real public integration was subsequently completed for `octokit/rest.js`: the generated consumer made actual generation **201**, ready poll **302**, and download **200** requests without a token, returning SPDX-2.3 with 1,764 packages. The live run uncovered and fixed response-body error reporting and a too-tight deadline; the bounded default is now 60 seconds. This proves that public case only. See [live evidence and limitations](docs/sbom-proposal-milestone.md#real-public-integration-completed); regression mock tests are not counted as integration proof.
