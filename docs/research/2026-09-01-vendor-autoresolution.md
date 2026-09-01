# Vendor auto-resolution research (2026-09-01)

Question: given only a dependency name, can the system discover the vendor's spec/changelog/docs itself? Answer: yes — layered ladder below. Sources: Context.dev docs mirror; web research agent (APIs.guru, conventions, registry metadata reliability).

## The ladder (order, cost, expected hit-rate)
1. **Registry metadata** — npm `repository.url` (most reliable field) / PyPI `project_urls` → GitHub org + homepage. Free. ~70–80% for popular packages. (PyPI's "Changelog" url key is present in ~0.04% of packages — bonus signal only.)
2. **GitHub spec-repo convention** — probe `github.com/<org>/openapi`, `<org>/<name>-openapi`, `<org>/api-spec`; its Releases tab doubles as the changelog. Free. ~30–40% for API-first SaaS (confirmed live: klaviyo/openapi exists with releases). Single most reliable convention for our target vendors.
3. **APIs.guru directory** — `api.apis.guru/v2/list.json`, 1,913 APIs / ~58k endpoints, queryable free, community-maintained; biased to big vendors (~20–30%). An MCP wrapper exists (rawveg/openapi-directory-mcp, maintenance unverified).
4. **Well-known probes on the vendor domain** — `/openapi.json`, `/openapi.yaml`, `/.well-known/openapi`, `/.well-known/api-catalog` (RFC 9727, Jun 2025 — too new for real adoption), plus changelog paths `/changelog`, `/releases`, `/docs/changelog`, `/whats-new`, RSS autodiscovery `<link rel=alternate type=application/rss+xml>`, and hosted-changelog widget signatures (Headway/Canny/Beamer). Free, <10% each but near-zero cost.
5. **Context.dev agentic search+extract** — `POST /web/search` (1 credit /10 results, can scrape results in-call) with queries like "<vendor> API changelog / openapi spec", then Extract with schema `{changelog_url, openapi_url, docs_url}` against the vendor site (10 credits). ~90%+ coverage, noisiest — verify the found page is vendor-owned (domain match) before trusting. Cents per vendor, once.
6. Result cached as an auto-generated pack marked `resolved: auto` — the system writes its own address-book entries; humans/community only verify/correct. Seed packs = pre-verified cache for the top vendors.

## Notable
- No existing product does "find the API spec for X" as a service — only composable pieces (Exa/Tavily/Firecrawl, APIs.guru). Our ladder is itself a small differentiator.
- Postman's 100k-API network has no confirmed open programmatic query path — not usable.
- janwilmake/openapisearch worth inspecting for extra probe heuristics.

## Proposed plan mapping (pending user approval)
- Phase 2: new task "vendor auto-resolution (ladder steps 1–4)" — pure HTTP probes + APIs.guru, no LLM, injected fetch, cached results.
- Phase 3: ladder step 5 joins the Context.dev task (search+extract live there).
- `autoshim add <name>` and `autoshim init` both call the ladder; pasting a URL remains the manual override.
