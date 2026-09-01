import { createHash } from "node:crypto";
import type { Ecosystem, Vendor, Watch, WatchTarget } from "./types.js";
import type { PackRegistry } from "./packs.js";

// ---------------------------------------------------------------------------
// Public contract (Task 4b brief)
// ---------------------------------------------------------------------------

export interface SearchProvider {
  search(query: string, limit: number): Promise<{ url: string; title: string; snippet?: string }[]>;
}

export type ResolutionRung = "pack" | "registry" | "github_convention" | "directory" | "wellknown" | "search";

export interface ResolvedVendor {
  vendor: Vendor;
  watch: Watch;
  resolution: { rung: ResolutionRung; confidence: number; evidence: string[] }[];
}

export interface ResolveDeps {
  fetchFn?: typeof fetch;
  search?: SearchProvider | null;
  registry: PackRegistry;
}

export interface ResolveInput {
  packageName?: string;
  ecosystem?: Ecosystem;
  name?: string;
  homepage?: string;
}

/** Thrown synchronously when the input carries no usable signal at all. Never a network/rung failure. */
export class ResolveInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolveInputError";
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type CandidateKind = "openapi" | "changelog" | "page" | "github_repo";

interface Candidate {
  url: string;
  kind: CandidateKind;
  githubRepo?: string; // "owner/repo", only for kind === "github_repo"
  hasReleases?: boolean;
  baseScore: number;
  note: string;
}

type FetchRung = Exclude<ResolutionRung, "pack">;

interface RungOutcome {
  rung: FetchRung;
  candidates: Candidate[];
  attemptNotes: string[]; // always non-empty: what this rung tried and what it found (or why not)
  discoveredHomepage?: string;
}

const ALL_FETCH_RUNGS: FetchRung[] = ["registry", "github_convention", "directory", "wellknown", "search"];

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics after decomposition
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base) return base;
  // Fallback for inputs with no representable ASCII content (pure unicode/symbols):
  // deterministic and non-empty, so callers always get a stable vendor id.
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 8);
  return `vendor-${hash}`;
}

function domainOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function normalizeUrlKey(url: string): string {
  try {
    const u = new URL(url);
    let key = `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname}`;
    if (key.length > 1 && key.endsWith("/")) key = key.slice(0, -1);
    return key;
  } catch {
    return url.trim();
  }
}

/** Accepts git+https/git+ssh/git/https/ssh-shorthand repository URLs; returns null for non-GitHub or unparsable input. */
function normalizeGithubRepo(raw: string | undefined | null): { owner: string; repo: string } | null {
  if (!raw) return null;
  let s = raw.trim();

  const sshShort = s.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (sshShort) return { owner: sshShort[1], repo: sshShort[2] };

  s = s.replace(/^git\+/, "");
  try {
    const u = new URL(s);
    if (u.hostname.toLowerCase() !== "github.com") return null;
    const parts = u.pathname.replace(/^\//, "").replace(/\.git$/i, "").split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

async function safeFetch(fetchFn: typeof fetch, url: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetchFn(url, { ...init, signal: AbortSignal.timeout(5000) });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rungs — each is independent, catches its own errors, never throws.
// ---------------------------------------------------------------------------

async function rungRegistry(fetchFn: typeof fetch, ecosystem: Ecosystem | undefined, packageName: string | undefined): Promise<RungOutcome> {
  const candidates: Candidate[] = [];
  const notes: string[] = [];

  if (!packageName || !ecosystem) {
    notes.push("registry: skipped (no packageName/ecosystem provided)");
    return { rung: "registry", candidates, attemptNotes: notes };
  }

  if (ecosystem === "gomod") {
    const m = packageName.match(/^github\.com\/([^/]+)\/([^/]+)/);
    if (m) {
      const owner = m[1];
      const repo = m[2].replace(/\/v\d+$/, "");
      candidates.push({
        url: `https://github.com/${owner}/${repo}`,
        kind: "github_repo",
        githubRepo: `${owner}/${repo}`,
        baseScore: 0.55,
        note: `go module path implies github repo ${owner}/${repo}`,
      });
      notes.push(`registry: derived github repo ${owner}/${repo} from go module path`);
    } else {
      notes.push(`registry: go module path ${packageName} is not github-hosted, no structural hit`);
    }
    return { rung: "registry", candidates, attemptNotes: notes };
  }

  if (ecosystem === "rubygems") {
    notes.push("registry: rubygems metadata lookup is not implemented in v1 (relies on other rungs)");
    return { rung: "registry", candidates, attemptNotes: notes };
  }

  const url = ecosystem === "npm"
    ? `https://registry.npmjs.org/${packageName}`
    : `https://pypi.org/pypi/${packageName}/json`;

  const res = await safeFetch(fetchFn, url);
  if (!res) {
    notes.push(`registry: network error fetching ${url}`);
    return { rung: "registry", candidates, attemptNotes: notes };
  }
  if (!res.ok) {
    notes.push(`registry: ${url} returned HTTP ${res.status}`);
    return { rung: "registry", candidates, attemptNotes: notes };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    notes.push(`registry: ${url} returned a non-JSON body`);
    return { rung: "registry", candidates, attemptNotes: notes };
  }

  let discoveredHomepage: string | undefined;

  if (ecosystem === "npm") {
    const b = body as { repository?: { url?: string } | string; homepage?: string };
    const repoUrlRaw = typeof b.repository === "string" ? b.repository : b.repository?.url;
    const repo = normalizeGithubRepo(repoUrlRaw);
    if (repo) {
      candidates.push({
        url: `https://github.com/${repo.owner}/${repo.repo}`,
        kind: "github_repo",
        githubRepo: `${repo.owner}/${repo.repo}`,
        baseScore: 0.55,
        note: `npm registry.repository.url -> ${repo.owner}/${repo.repo}`,
      });
    }
    if (b.homepage && domainOf(b.homepage) && domainOf(b.homepage) !== "github.com") {
      discoveredHomepage = b.homepage;
      candidates.push({ url: b.homepage, kind: "page", baseScore: 0.55, note: `npm registry.homepage -> ${b.homepage}` });
    }
    notes.push(repo || discoveredHomepage
      ? `registry: npm metadata for ${packageName} yielded ${[repo ? "a repository" : null, discoveredHomepage ? "a homepage" : null].filter(Boolean).join(" and ")}`
      : `registry: npm metadata for ${packageName} had no usable repository.url or homepage`);
  } else {
    const b = body as { info?: { home_page?: string | null; project_urls?: Record<string, string> | null } };
    const info = b.info ?? {};
    const projectUrls = info.project_urls ?? {};
    const homepageCandidate = info.home_page || projectUrls.Homepage || projectUrls.homepage || undefined;
    const sourceUrl = projectUrls.Source || projectUrls.source || projectUrls.Repository || projectUrls.repository || projectUrls.Code || homepageCandidate;
    const repo = normalizeGithubRepo(sourceUrl ?? undefined);
    if (repo) {
      candidates.push({
        url: `https://github.com/${repo.owner}/${repo.repo}`,
        kind: "github_repo",
        githubRepo: `${repo.owner}/${repo.repo}`,
        baseScore: 0.55,
        note: `pypi project_urls -> ${repo.owner}/${repo.repo}`,
      });
    }
    if (homepageCandidate && domainOf(homepageCandidate) !== "github.com") {
      discoveredHomepage = homepageCandidate;
      candidates.push({ url: homepageCandidate, kind: "page", baseScore: 0.55, note: `pypi info.home_page -> ${homepageCandidate}` });
    }
    notes.push(repo || homepageCandidate
      ? `registry: pypi metadata for ${packageName} yielded ${[repo ? "a repository" : null, homepageCandidate ? "a homepage" : null].filter(Boolean).join(" and ")}`
      : `registry: pypi metadata for ${packageName} had no usable home_page/project_urls`);
  }

  return { rung: "registry", candidates, attemptNotes: notes, discoveredHomepage };
}

async function rungGithubConvention(fetchFn: typeof fetch, orgCandidates: string[], nameSlug: string): Promise<RungOutcome> {
  const candidates: Candidate[] = [];
  const notes: string[] = [];

  if (orgCandidates.length === 0) {
    notes.push("github_convention: skipped (no org guess available)");
    return { rung: "github_convention", candidates, attemptNotes: notes };
  }

  const probes = orgCandidates.flatMap((org) => [
    { org, repo: "openapi" },
    { org, repo: `${nameSlug}-openapi` },
    { org, repo: "api-spec" },
  ]);

  const results = await Promise.all(
    probes.map(async (p) => {
      const repoRes = await safeFetch(fetchFn, `https://api.github.com/repos/${p.org}/${p.repo}`, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!repoRes || !repoRes.ok) return null;

      const relRes = await safeFetch(fetchFn, `https://api.github.com/repos/${p.org}/${p.repo}/releases?per_page=1`, {
        headers: { Accept: "application/vnd.github+json" },
      });
      let hasReleases = false;
      if (relRes && relRes.ok) {
        try {
          const arr = await relRes.json();
          hasReleases = Array.isArray(arr) && arr.length > 0;
        } catch {
          hasReleases = false;
        }
      }
      return { org: p.org, repo: p.repo, hasReleases };
    })
  );

  for (const r of results) {
    if (!r) continue;
    candidates.push({
      url: `https://github.com/${r.org}/${r.repo}`,
      kind: "github_repo",
      githubRepo: `${r.org}/${r.repo}`,
      hasReleases: r.hasReleases,
      baseScore: r.hasReleases ? 0.5 : 0.35,
      note: `github convention repo ${r.org}/${r.repo} exists${r.hasReleases ? " and has releases" : ""}`,
    });
  }

  notes.push(
    candidates.length > 0
      ? `github_convention: ${candidates.length} of ${probes.length} convention probe(s) matched`
      : `github_convention: none of ${probes.length} convention probes matched (orgs tried: ${orgCandidates.join(", ")})`
  );

  return { rung: "github_convention", candidates, attemptNotes: notes };
}

async function rungDirectory(fetchFn: typeof fetch, homepage: string | undefined, vendorSlug: string): Promise<RungOutcome> {
  const candidates: Candidate[] = [];
  const notes: string[] = [];

  const res = await safeFetch(fetchFn, "https://api.apis.guru/v2/list.json");
  if (!res) {
    notes.push("directory: network error fetching apis.guru list.json");
    return { rung: "directory", candidates, attemptNotes: notes };
  }
  if (!res.ok) {
    notes.push(`directory: apis.guru list.json returned HTTP ${res.status}`);
    return { rung: "directory", candidates, attemptNotes: notes };
  }

  let list: Record<string, { preferred: string; versions: Record<string, { swaggerUrl?: string; swaggerYamlUrl?: string }> }>;
  try {
    list = await res.json();
  } catch {
    notes.push("directory: apis.guru list.json was not valid JSON");
    return { rung: "directory", candidates, attemptNotes: notes };
  }

  const domain = domainOf(homepage) ?? `${vendorSlug}.com`;
  const entry = list[domain];
  if (entry) {
    const version = entry.versions[entry.preferred];
    const swaggerUrl = version?.swaggerUrl ?? version?.swaggerYamlUrl;
    if (swaggerUrl) {
      candidates.push({ url: swaggerUrl, kind: "openapi", baseScore: 0.5, note: `apis.guru exact domain match: ${domain}` });
    }
  }

  notes.push(candidates.length > 0 ? `directory: apis.guru domain match for ${domain}` : `directory: no apis.guru entry for domain ${domain}`);
  return { rung: "directory", candidates, attemptNotes: notes };
}

const WELLKNOWN_OPENAPI_PATHS = ["/openapi.json", "/openapi.yaml", "/.well-known/openapi", "/.well-known/api-catalog"];
const WELLKNOWN_CHANGELOG_PATHS = ["/changelog", "/docs/changelog", "/releases"];

// A 2xx alone isn't enough: parked domains and catch-all routers happily return 200 HTML for any
// path. An openapi candidate must plausibly BE a spec (JSON/YAML/plain text); a changelog
// candidate just needs to be a page a human (or our own future page-diff source) can read.
const OPENAPI_CONTENT_TYPES = ["application/json", "application/yaml", "text/yaml", "text/plain"];
const CHANGELOG_CONTENT_TYPES = ["text/html", "text/plain", "application/xhtml+xml"];

function contentTypeAllowed(res: Response, kind: "openapi" | "changelog"): boolean {
  const raw = res.headers.get("content-type");
  if (!raw) return kind === "changelog"; // no header at all: tolerate for pages, reject for specs
  const type = raw.split(";")[0].trim().toLowerCase();
  const allowed = kind === "openapi" ? OPENAPI_CONTENT_TYPES : CHANGELOG_CONTENT_TYPES;
  return allowed.includes(type);
}

async function rungWellKnown(fetchFn: typeof fetch, homepage: string | undefined, vendorSlug: string): Promise<RungOutcome> {
  const candidates: Candidate[] = [];
  const notes: string[] = [];
  const domain = domainOf(homepage) ?? `${vendorSlug}.com`;
  const base = `https://${domain}`;

  const probeOne = async (path: string, kind: "openapi" | "changelog") => {
    const res = await safeFetch(fetchFn, `${base}${path}`);
    if (res && res.ok && contentTypeAllowed(res, kind)) {
      candidates.push({ url: `${base}${path}`, kind, baseScore: 0.3, note: `well-known probe hit: ${base}${path}` });
    }
  };

  await Promise.all([
    ...WELLKNOWN_OPENAPI_PATHS.map((p) => probeOne(p, "openapi")),
    ...WELLKNOWN_CHANGELOG_PATHS.map((p) => probeOne(p, "changelog")),
  ]);

  const total = WELLKNOWN_OPENAPI_PATHS.length + WELLKNOWN_CHANGELOG_PATHS.length;
  notes.push(
    candidates.length > 0
      ? `wellknown: ${candidates.length} of ${total} probe(s) on ${domain} succeeded`
      : `wellknown: none of ${total} probes on ${domain} succeeded`
  );

  return { rung: "wellknown", candidates, attemptNotes: notes };
}

async function rungSearch(search: SearchProvider | null | undefined, vendorName: string): Promise<RungOutcome> {
  const candidates: Candidate[] = [];
  const notes: string[] = [];

  if (!search) {
    notes.push("search: skipped (no SearchProvider configured)");
    return { rung: "search", candidates, attemptNotes: notes };
  }

  try {
    const [changelogHits, specHits] = await Promise.all([
      search.search(`${vendorName} API changelog`, 5),
      search.search(`${vendorName} openapi spec`, 5),
    ]);
    for (const hit of changelogHits) {
      candidates.push({ url: hit.url, kind: "changelog", baseScore: 0.25, note: `search hit for "${vendorName} API changelog": ${hit.title}` });
    }
    for (const hit of specHits) {
      candidates.push({ url: hit.url, kind: "openapi", baseScore: 0.25, note: `search hit for "${vendorName} openapi spec": ${hit.title}` });
    }
    notes.push(`search: ${candidates.length} raw hit(s) returned (subject to cross-validation)`);
  } catch (err) {
    notes.push(`search: provider threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { rung: "search", candidates, attemptNotes: notes };
}

// ---------------------------------------------------------------------------
// Combiner — cross-validation scoring over all settled rung outcomes.
// ---------------------------------------------------------------------------

interface GroupEntry {
  candidate: Candidate;
  contributions: { rung: FetchRung; baseScore: number; note: string }[];
}

interface Winner {
  candidate: Candidate;
  confidence: number;
  contributions: { rung: FetchRung; note: string }[];
}

function groupKeyFor(c: Candidate): string {
  return c.kind === "github_repo" ? `github:${c.githubRepo!.toLowerCase()}` : `${c.kind}:${normalizeUrlKey(c.url)}`;
}

function combine(
  outcomes: RungOutcome[],
  ctx: { packageName?: string; ecosystem?: Ecosystem; name?: string; homepage?: string; vendorSlug: string }
): ResolvedVendor | null {
  const confirmedHomepage = ctx.homepage ?? outcomes.find((o) => o.discoveredHomepage)?.discoveredHomepage;
  const confirmedDomain = domainOf(confirmedHomepage);

  const registryOutcome = outcomes.find((o) => o.rung === "registry");
  const confirmedGithubOwner = registryOutcome?.candidates.find((c) => c.kind === "github_repo")?.githubRepo?.split("/")[0]?.toLowerCase() ?? null;

  const groups = new Map<string, GroupEntry>();
  for (const outcome of outcomes) {
    for (const c of outcome.candidates) {
      const key = groupKeyFor(c);
      let entry = groups.get(key);
      if (!entry) {
        entry = { candidate: c, contributions: [] };
        groups.set(key, entry);
      }
      if (c.baseScore > entry.candidate.baseScore || (c.hasReleases && !entry.candidate.hasReleases)) {
        entry.candidate = c;
      }
      const already = entry.contributions.find((x) => x.rung === outcome.rung);
      if (!already) {
        entry.contributions.push({ rung: outcome.rung, baseScore: c.baseScore, note: c.note });
      } else if (c.baseScore > already.baseScore) {
        already.baseScore = c.baseScore;
        already.note = c.note;
      }
    }
  }

  const winners: Winner[] = [];
  for (const entry of groups.values()) {
    const rungsInvolved = entry.contributions.map((c) => c.rung);
    const searchOnly = rungsInvolved.length === 1 && rungsInvolved[0] === "search";

    const domainVerified =
      entry.candidate.kind === "github_repo"
        ? entry.candidate.githubRepo!.split("/")[0].toLowerCase() === confirmedGithubOwner
        : domainOf(entry.candidate.url) !== null && domainOf(entry.candidate.url) === confirmedDomain;

    // Cross-validation: a candidate found only by search, on a domain we cannot independently
    // confirm belongs to the vendor, is rejected outright per the brief.
    if (searchOnly && !domainVerified) continue;

    const sumScore = entry.contributions.reduce((acc, c) => acc + c.baseScore, 0);
    if (!(rungsInvolved.length >= 2 || domainVerified || sumScore >= 0.5)) continue;

    winners.push({
      candidate: entry.candidate,
      confidence: Math.min(0.95, sumScore + (domainVerified ? 0.3 : 0)),
      contributions: entry.contributions.map((c) => ({ rung: c.rung, note: c.note })),
    });
  }

  const bestOfKind = (kind: CandidateKind) => winners.filter((w) => w.candidate.kind === kind).sort((a, b) => b.confidence - a.confidence)[0];

  const bestOpenapi = bestOfKind("openapi");
  // A github repo is only useful as a `github_release` watch target when it actually has
  // releases; prefer that one for both the target and the vendor's recorded github_repo,
  // falling back to the highest-confidence repo hit (e.g. an SDK repo with no releases)
  // purely as informational metadata otherwise.
  const githubWinners = winners.filter((w) => w.candidate.kind === "github_repo").sort((a, b) => b.confidence - a.confidence);
  const bestGithubWithReleases = githubWinners.find((w) => w.candidate.hasReleases);
  const bestGithub = bestGithubWithReleases ?? githubWinners[0];
  const bestChangelog = bestOfKind("changelog");
  const bestPage = bestOfKind("page");

  const targets: WatchTarget[] = [];
  if (bestOpenapi) targets.push({ type: "openapi", url: bestOpenapi.candidate.url });
  if (bestGithubWithReleases) targets.push({ type: "github_release", repo: bestGithubWithReleases.candidate.githubRepo! });
  const pageWinner = bestChangelog ?? bestPage;
  if (pageWinner) targets.push({ type: "page", url: pageWinner.candidate.url, detection: "semantic" });

  if (targets.length === 0) return null;

  const vendorId = `custom_${ctx.vendorSlug}`;
  const vendor: Vendor = {
    id: vendorId,
    display_name: ctx.name ?? ctx.packageName ?? ctx.vendorSlug,
    kind: "generic",
    homepage: confirmedHomepage,
    changelog_url: bestChangelog?.candidate.url,
    openapi_url: bestOpenapi?.candidate.url,
    github_repo: bestGithub?.candidate.githubRepo,
    sdk_packages: ctx.packageName && ctx.ecosystem ? [{ ecosystem: ctx.ecosystem, name: ctx.packageName }] : [],
  };

  const watch: Watch = { vendor_id: vendorId, targets, status: "active" };

  const resolution = outcomes.map((outcome) => {
    const contributing = winners.filter((w) => w.contributions.some((c) => c.rung === outcome.rung));
    const confidence = contributing.length > 0 ? Math.max(...contributing.map((w) => w.confidence)) : 0;
    const winnerNotes = contributing.flatMap((w) => w.contributions.filter((c) => c.rung === outcome.rung).map((c) => c.note));
    return { rung: outcome.rung as ResolutionRung, confidence, evidence: [...outcome.attemptNotes, ...winnerNotes] };
  });

  return { vendor, watch, resolution };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function resolveVendorAuto(input: ResolveInput, deps: ResolveDeps): Promise<ResolvedVendor | null> {
  const packageName = input.packageName?.trim() || undefined;
  const name = input.name?.trim() || undefined;
  const homepage = input.homepage?.trim() || undefined;

  if (!packageName && !name && !homepage) {
    throw new ResolveInputError("resolveVendorAuto requires at least one of packageName, name, or homepage");
  }

  // Rung "pack": short-circuits everything else — no network calls needed when we already
  // ship a curated, human-verified answer for this package.
  if (packageName && input.ecosystem) {
    const pack = deps.registry.byPackage(input.ecosystem, packageName);
    if (pack) {
      const vendor = deps.registry.vendorFor(pack);
      return {
        vendor,
        watch: { vendor_id: vendor.id, targets: pack.watch, status: "active" },
        resolution: [{ rung: "pack", confidence: 1, evidence: [`pack registry match: ${pack.id} (${input.ecosystem}:${packageName})`] }],
      };
    }
  }

  const fetchFn = deps.fetchFn ?? fetch;

  const scopeMatch = packageName?.match(/^@([^/]+)\//);
  const bareName = packageName ? packageName.replace(/^@[^/]+\//, "") : undefined;
  const orgCandidateSeeds = new Set<string>();
  if (name) orgCandidateSeeds.add(slugify(name));
  if (scopeMatch) orgCandidateSeeds.add(slugify(scopeMatch[1]));
  if (bareName) {
    orgCandidateSeeds.add(slugify(bareName));
    const suffixStripped = bareName.replace(/-(api|sdk|js|node|py|python|client)$/i, "");
    if (suffixStripped !== bareName) orgCandidateSeeds.add(slugify(suffixStripped));
  }
  const orgCandidates = [...orgCandidateSeeds].filter(Boolean).slice(0, 3);

  const vendorSlugSeed = name ?? bareName ?? domainOf(homepage) ?? homepage ?? "vendor";
  const vendorSlug = slugify(vendorSlugSeed);

  const rungPromises: Promise<RungOutcome>[] = [
    rungRegistry(fetchFn, input.ecosystem, packageName),
    rungGithubConvention(fetchFn, orgCandidates, vendorSlug),
    rungDirectory(fetchFn, homepage, vendorSlug),
    rungWellKnown(fetchFn, homepage, vendorSlug),
    rungSearch(deps.search, name ?? packageName ?? vendorSlug),
  ];

  const settled = await Promise.allSettled(rungPromises);
  const outcomes: RungOutcome[] = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    const rung = ALL_FETCH_RUNGS[i];
    return {
      rung,
      candidates: [],
      attemptNotes: [`${rung}: rung threw unexpectedly: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`],
    };
  });

  return combine(outcomes, { packageName, ecosystem: input.ecosystem, name, homepage, vendorSlug });
}
