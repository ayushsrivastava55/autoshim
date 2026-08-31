# Autoshim

**Renovate for the APIs you don't control.**

Autoshim watches every third-party API your repo depends on — OpenAPI specs, changelogs, GitHub releases — and when a vendor ships a breaking change, it finds the affected lines in your code and opens a draft PR with the fix. Before production breaks.

> Status: pre-alpha, building in public. Spec and plan live in [`docs/`](docs/).

## How it will work

```
npx autoshim init                          # discover integrations in your repo
npx autoshim add --openapi <url>           # watch ANY vendor with a spec
npx autoshim watch --once                  # poll, classify, impact-scan, heal
```

- **Any vendor**: paste an OpenAPI/Swagger URL, a changelog URL, or a GitHub repo — no curated-list gatekeeping
- **Deterministic first**: structural spec diffs, not LLM guesswork; LLM only where prose is the only source
- **Draft PRs only**: evidence, source links, and safety caps (≤20 files, ≤400 lines) — a human always merges
- **OSS**: Apache-2.0 CLI + community vendor packs; hosted team product later

## License

Apache-2.0
