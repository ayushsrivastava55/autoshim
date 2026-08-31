# Autoshim — competitor landscape (researched 2026-09-01)

Method: Exa web search, GitHub search/API, HN Algolia, live landing-page reads
(Jina Reader). All claims below were read directly from the products' own
pages on 2026-09-01 unless noted.

## TL;DR

The idea is **not** unique — at least five young products attack "third-party
API changes break your code," and two of them already claim the auto-PR/auto-fix part (per their landing pages; not verified in a live PR).
But **none has traction** (no HN footprint — the one traction channel checked; no visible customers, one
site still has template-literal bugs on its pricing page), and the established
players all stop adjacent to the problem. The category is validated and open;
speed and execution quality decide it.

## Direct competitors (same problem, same buyer)

| Product | What it does | Heals code? | Pricing | Maturity signals |
|---|---|---|---|---|
| **apidrift.co** ("API drift watch") | Watches vendor changelogs (Stripe, OpenAI, Twilio, "more weekly"), finds affected lines via **AST (ts-morph)**, opens migration PRs with reasoning + doc links. GitHub App, PR-only perms. | **Yes — closest to Autoshim's hosted product** | $29/mo after 14 days, card upfront, unlimited repos | Only 3 vendors live; TS-only (ts-morph); no HN/social footprint |
| **mendapi.com** | Local-first CLI: `npx mendapi sync/scan/fix`. Monitors 20+ providers centrally, scans repo locally (zero network calls), drafts diffs from official migration guides. MCP server for Claude Code/Cursor. AGPL scanner. Fintech angle (Stripe/Plaid/PayPal "audited fix packs"). | **Yes — closest to Autoshim's CLI** | n/a on page | v0.5; polished copy; no HN footprint |
| **changeguard.dev** | Watches provider specs/docs, severity classification, nightly smoke tests on "golden calls", **PR gate in CI**, auto-PRs "for common renames (TypeScript)" | Partially (renames only) | Broken: pricing shows `${t.price}/mo`, CTA is `calendly.com/your-link` | Clearly unfinished/vibe-coded; SOC2 "in progress" |
| **apidrift.dev** ("APIDrift") | Monitors 26+ changelogs (HTML/GitHub Releases/RSS/Markdown), AI classification (7 categories, 3 severities), AI migration guides (text, not code), Slack/email/webhook, deprecation calendar, API health scores | No (guides only) | Free tier + Pro | Most complete *alerting* product; no repo connection at all |
| **breakwatch.dev** | Paste changelog/docs URLs, daily diff + classify (breaking/additive/docs-only), team alerts | No | Free (3 APIs) / €29 mo | "Early access, built for small dev teams"; no repo connection |

Also seen: **apiguard.co** (drift-detection blog/SEO play; site timed out),
**AutoHeal.ai** (GitHub hackathon-style demo: runtime 400-interception →
Gemini patch → PR; mock vendor only), **BreakShield CI** (AST breaking-change
detection in PRs, 3 HN points).

Traction check (HN Algolia): none of the five has a single scoring post.
This wave is weeks-to-months old and nobody has won distribution.

## Adjacent / established (different core job)

- **oasdiff** (⭐1.3k, active) and **pb33f/openapi-changes** (⭐359) — OSS
  OpenAPI diff engines. Producer-side (API *owners* checking their own specs).
  Building blocks, not products for consumers of APIs. Validates our
  own-differ plan; also a make-vs-take option.
- **Optic** (⭐1.5k) — API diff/linting for your *own* API in CI; repo dormant (last push Jan 2026).
- **changedetection.io** (⭐33k) — generic page-watching; no classification,
  no repo link. This is the "don't compete with Context.dev" layer.
- **Dependabot / Renovate** — package *versions*, not vendor contracts; no
  call-site fixing. **Infield.ai** — managed OSS dependency upgrades incl.
  fixing breaking changes (human-in-the-loop service, different wedge:
  packages not vendor APIs).
- **Speakeasy / Stainless** — generate SDKs from specs for API *producers*;
  reduce the problem for vendors that adopt them, don't help consumers.
- **Superface** — the original "self-healing integrations" pitch (2021–24);
  superface.ai did not load a Superface product page when checked (scrape returned a stub referencing arcpay.ai — current state unverified). The first-generation
  approach (runtime abstraction layer) appears abandoned; the PR-based approach is the
  current wave.

## What this means for Autoshim

1. **Category validated, unwon.** Five indie attempts in months = real pain,
   real zeitgeist. Zero traction = distribution is the game, not the idea.
2. **Differentiators that hold up against this field:**
   - **Any vendor via OpenAPI spec diff** — every direct competitor watches a
     curated vendor list (3–26); none lets you paste an arbitrary
     OpenAPI/Swagger URL. Our generic-mode + spec-diff design is the moat.
   - **OSS CLI + packs (Apache-2.0)** — only mendapi is OSS (AGPL, scanner
     only). An Apache CLI with community packs can win GitHub distribution
     the way Renovate did.
   - **Python + JS/TS healing** — apidrift.co is TS-only.
3. **Ideas worth stealing (cheap, proven by competitors):**
   - PR-only GitHub permissions as a trust headline (apidrift.co)
   - "Never push to default branch" copy (apidrift.co)
   - MCP server exposing scan/heal to Claude Code/Cursor (mendapi) — natural
     for us later, our core is already CLI-shaped
   - Deprecation calendar / digest for additive changes (apidrift.dev)
     matches our "additive → digest email" plan
4. **Avoid:** launch-before-it-works (changeguard's `${t.price}` pricing);
   alert-only positioning (crowded, weakest end of the field).
5. **Naming note:** "APIDrift"/"apidrift" is used by two separate competitors;
   good thing we didn't pick a drift-name. No conflict found for "autoshim".

## Open risks

- apidrift.co's "per-vendor knowledge compounds across the customer base" is
  a real long-term moat if they get customers first.
- Any of these could add generic OpenAPI watching quickly; our lead is
  execution + OSS distribution, not secrecy.
