# Fundable strategy synthesis (2026-09-02)

Four research agents: funding lens (incl. RFS author), OSS star-growth playbook, monetization/buyer,
wedge/demo. Corrections and decisions below supersede earlier strategy notes where they conflict.

## Corrections to earlier assumptions
- Harsha Gaddipati (RFS "Self-Maintaining APIs" author) is NOT a YC partner: founder of Slashy
  (YC S25), ex-AWS, guest RFS contributor. His views = credible founder, not YC doctrine.
- Vendor-pays model has NO precedent: Shopify/Stripe built deprecation assistants in-house; no
  vendor found paying third parties. Vendor relationship = distribution partnership only.
- Closest comps (Infield W20, API Tracker W20) took years to reach visible traction. YC's bar is
  GROWTH RATE of a usage metric, not absolute scale.

## The wedge: `npx autoshim scan` (retroactive report card)
Instant, read-only, no auth, no PR-write trust: "your repo talks to 14 APIs; 3 shipped breaking
changes in the last 90 days you never saw — here are the call sites." Direct precedent: npm audit,
Snyk test, npkill, depcheck (run once, get scared/relieved, tell a friend). Output is screenshot-
native. Ends with the CTA to `autoshim watch`. The full watch→PR loop is the PRODUCT; the scan is
the DEMO and the top of funnel. Second wedge: public "API Breakage Radar" (Have-I-Been-Pwned
model: SEO + content flywheel feeding the scan). README badge as near-free compounding.

## Narrow story, generic engine
Adopt the RFS author's "one high-churn ecosystem first" for GTM ONLY: launch narrative built on
the three rage incidents — OpenAI Assistants API sunset (Aug 26 2026, no auto-migration, still
bleeding), Shopify REST→GraphQL forced migration, Stripe versioning as the counter-example.
Demo vendors: OpenAI/Anthropic SDKs, Stripe, Shopify. The generic resolver/differ stays the
moat under the hood; "any vendor" becomes the second paragraph, not the headline.

## Architecture (unchanged): brief-first, execution pluggable
Deterministic detection + judgment produce Fix Briefs; execute-self (capped healer) for demo and
agent-less users; execute-agent (customer's Claude Code/Devin) as fast-follow; MCP as channel.
Anti-noise doctrine: PR only when breaking AND provably used AND high-confidence.

## Business model
- Free OSS CLI: unlimited vendors/repos, scan + briefs, MCP + skill + Action (Sentry-style trio).
- Hosted GitHub App priced per MONITORED VENDOR API (not seats): Starter $49–99 (≤10 APIs,
  briefs), Growth $199–299 (≤25 APIs, draft PRs, CI gate), Enterprise (SSO, SLA, SOC2 CC9.2
  evidence export). Security/vendor-risk budget framing (Socket/Semgrep/StepSecurity comps at
  $25–50/contributor/mo; Semgrep $100M Series D) beats "dev productivity" framing.
- Positioning line: "Autoshim opens a PR only when it can prove you're hit."

## YC application framing
- Infrastructure that keeps agent-maintained codebases correct as vendor APIs drift (matches
  2026 a16z/Sequoia/YC thesis language) — cite the RFS verbatim + its 30%-downtime stat (hedged
  as self-reported).
- Traction targets by Nov 2: organic stars in the hundreds with a clean velocity shape (diligence
  checks star-velocity; StarScout flagged 6M fake stars), ≥3 documented real catches with
  evidence-backed fix briefs/PRs against OpenAI/Shopify/Stripe-class APIs, weekly-growing scan
  installs, the Radar as a public artifact, first paying design partner if possible.

## 8-week launch plan (Sep 2 → Nov 2)
Wk1–2: build `scan` (backfill feed + impact pyramid L1/L2) + README (VHS GIF ≤30s, "why not
  Dependabot" table, one-command run); seed 100–200 stars from network.
Wk3: Show HN Monday 00:00 UTC (data: highest hit rate; 92% of star effect within 48h) + same-week
  Reddit r/devops, r/node, r/python + awesome-mcp-servers PR.
Wk4: Product Hunt; newsletter pitches (TLDR/Console/Changelog) with real numbers; Radar v0.
Wk5: weekly release cadence; "add your vendor" contribution surface; good-first-issues (24h SLA).
Wk6: watch→PR loop public; retro post "we caught N real breaking changes".
Wk7: metrics consolidation; design-partner outreach (SOC2-driven teams).
Wk8: YC app with growth curves. Anti-patterns: no bought stars, no vote rings, no listicle spam.

## Build-order change (pending approval)
Old: Phase 3 watchers → Phase 4 impact/heal → Phase 5 CLI. New: **Phase 3' = SCAN** (historical
change backfill from GitHub releases + spec-repo git history through our differ; impact pyramid
L1+L2; `autoshim scan` command; README+GIF) → Phase 4 = WATCH loop + heal/PR (execute-self) →
Phase 5 = Radar site, MCP, Action, execute-agent. The demo-able wedge ships first.
