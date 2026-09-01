// Usage: node scripts/fetch-github-spec-fixture.mjs
//
// Downloads two revisions of the GitHub REST API OpenAPI description into the
// gitignored fixtures/specs/downloaded/ directory, for the net-gated perf test
// in packages/core/test/spec-diff-github.test.ts. Run manually / by the executor
// once; never invoked by CI or by the normal test suite (which has no live network).
//
// raw.githubusercontent.com does not resolve relative revs like "heads/main~200", so
// these are two concrete commit SHAs, resolved via:
//   https://api.github.com/repos/github/rest-api-description/commits?path=${FILE}&per_page=100
// (newest commit that touched the file, and the ~100th-newest, ~10 months apart).
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

const dir = "fixtures/specs/downloaded";
mkdirSync(dir, { recursive: true });
const FILE = "descriptions/api.github.com/api.github.com.json";
const revs = {
  "github-a.json": "945021ca606a4884b0cae7bcad2d28c01619b332", // 2025-11-04
  "github-b.json": "92dc700c26e51bdb084f990f9c56a1815e5ec58a", // 2026-08-28
};

for (const [out, rev] of Object.entries(revs)) {
  const p = `${dir}/${out}`;
  if (existsSync(p)) continue;
  const url = `https://raw.githubusercontent.com/github/rest-api-description/${rev}/${FILE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  writeFileSync(p, await res.text());
  console.log("fetched", p);
}
