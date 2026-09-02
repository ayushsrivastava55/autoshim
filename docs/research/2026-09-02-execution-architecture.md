# Execution architecture decision (2026-09-02)

Question: is Autoshim (A) its own agent harness, (B) a connector/orchestrator dispatching the
user's coding agent, or (C) a tool/MCP server inside the user's agent?
Inputs: landscape research (harness/connector/MCP ground truth 2026) + community sentiment
(HN/Reddit-via-Exa; Dependabot fatigue, agent-access trust, MCP-vs-CLI) + YC RFS framing.

## Established facts
- MCP servers cannot initiate work; sampling (server-driven reasoning) deprecated in the
  2026-07-28 spec. <5% of ~20k listed servers monetize (unverified stat, directionally clear).
  → C is a distribution channel, never the spine.
- Claude Code GitHub Action is cleanly third-party-triggerable (@claude comment / prompt input,
  customer's key); Devin has a paid API; Codex/Cursor lack public dispatch. AGENTS.md is now a
  cross-agent briefing convention (Claude Code, Codex, Cursor, Devin, Copilot, et al).
- Own harness: precedented (Sweep/Ellipsis; OpenHands as infra), token COGS on the product,
  Anthropic subscription-vs-SDK billing flip-flopped mid-2026 (platform-policy risk).
- Sentiment consensus: Dependabot-style auto-PR volume = fatigue ("noise machine"); devs want
  risk summarized + actual usage checked BEFORE a PR exists; human merge-gate persists even in
  autonomous pipelines. Third-party repo write access carries a fresh trust tax (CamoLeak-class
  prompt-injection disclosures). CLI cheaper than MCP for agent-heavy teams (4-32x tokens).

## Decision: brief-first architecture ("the nervous system, not another pair of hands")
Autoshim's identity: the deterministic sensing + judgment layer. Its canonical product artifact
is the **Fix Brief** — an evidence-backed, structured document per breaking change: what broke
(rule ids, spec diff, source links, screenshot), where it hits THIS repo (files/lines, layer-
agreement confidence), suggested fix approach, safety constraints. PRs are one *rendering* of a
brief. Execution is a pluggable backend the USER chooses:

1. `--execute self` (v1, exists): our capped healer renders the brief into a draft PR.
   Needed for the self-contained demo and agent-less users. Caps stay (≤20 files/≤400 lines).
2. `--execute agent` (SP2 fast-follow): write the brief as an AGENTS.md-convention task /
   GitHub issue and trigger the customer's own agent (Claude Code Action via @claude with
   their key; Devin API for enterprises). Their credentials, their trust boundary, zero token
   COGS for us. This is the RFS's "agent should scan and fix" with the customer's agent.
3. `--execute none` / MCP (Task 17): brief only — into the terminal, an issue, or pulled by
   the user's agent mid-session via our MCP tools. The trust-first on-ramp.

## Anti-noise doctrine (the anti-Dependabot, from consensus sentiment)
PR only when: breaking/deprecation AND provably used in this repo AND confidence high.
Additive → digest. Unsure → Issue with the brief, never a PR. One open PR per vendor.
Positioning line: "Autoshim opens a PR only when it can prove you're hit — everything else
is a briefing, not a notification."

## Why this wins each constituency
- Devs: no noise, no ambient repo access unless they choose execute-self; brief runs inside
  their own review/agent loop.
- YC: demo-able end-to-end without external plumbing (execute self), while the architecture
  story IS the agent-economy thesis (briefs any agent can execute).
- Us: moat stays in detection+judgment (deterministic, ours); execution commoditizes — we
  surf that commoditization instead of competing with Claude Code.

## Plan impact (pending approval)
- New core type FixBrief + renderer (folds into Task 13 publish work, small).
- Task 17 MCP unchanged (brief/impact tools). `--execute agent` = SP2 task (GitHub App/PAT
  plumbing). Phase 3 watchers unaffected.
