import { describe, it, expect } from "vitest";
import { resolveVendorAuto, slugify, ResolveInputError } from "../src/resolve.js";
import type { ResolveDeps, SearchProvider } from "../src/resolve.js";
import type { Pack, PackRegistry } from "../src/packs.js";
import type { Vendor } from "../src/types.js";

type FakeRoute = { status: number; body?: unknown; isJson?: boolean } | "network-error";

function makeFakeFetch(routes: Record<string, FakeRoute>, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const route = routes[url];
    if (route === "network-error") throw new Error("simulated network failure");
    if (!route) return new Response(null, { status: 404 });
    if (route.isJson) {
      return new Response(JSON.stringify(route.body), { status: route.status, headers: { "content-type": "application/json" } });
    }
    return new Response(typeof route.body === "string" ? route.body : "", { status: route.status });
  }) as typeof fetch;
}

function fakeRegistry(overrides?: Partial<PackRegistry>): PackRegistry {
  return {
    byId: () => undefined,
    byPackage: () => undefined,
    all: () => [],
    vendorFor: (pack: Pack): Vendor => ({
      id: pack.id,
      display_name: pack.display_name,
      kind: "pack",
      homepage: pack.homepage,
      docs_url: pack.docs_url,
      changelog_url: pack.changelog_url,
      openapi_url: pack.openapi_url,
      github_repo: pack.github_repo,
      sdk_packages: [],
    }),
    ...overrides,
  };
}

const NPM = (pkg: string) => `https://registry.npmjs.org/${pkg}`;
const GH_REPO = (org: string, repo: string) => `https://api.github.com/repos/${org}/${repo}`;
const GH_RELEASES = (org: string, repo: string) => `https://api.github.com/repos/${org}/${repo}/releases?per_page=1`;
const GURU = "https://api.apis.guru/v2/list.json";
const wellKnown = (domain: string, path: string) => `https://${domain}${path}`;

describe("resolveVendorAuto", () => {
  it("(i) klaviyo-style: registry + github_convention agree -> github_release target, confidence >= 0.8", async () => {
    const calls: string[] = [];
    const fetchFn = makeFakeFetch(
      {
        [NPM("klaviyo-api")]: {
          status: 200,
          isJson: true,
          body: { repository: { type: "git", url: "git+ssh://git@github.com/klaviyo/klaviyo-api-node.git" }, homepage: "https://github.com/klaviyo/klaviyo-api-node#readme" },
        },
        [GH_REPO("klaviyo", "openapi")]: { status: 200, isJson: true, body: { id: 1, full_name: "klaviyo/openapi" } },
        [GH_RELEASES("klaviyo", "openapi")]: { status: 200, isJson: true, body: [{ tag_name: "v1" }] },
        [GURU]: { status: 200, isJson: true, body: {} },
      },
      calls
    );

    const deps: ResolveDeps = { fetchFn, search: null, registry: fakeRegistry() };
    const result = await resolveVendorAuto({ packageName: "klaviyo-api", ecosystem: "npm", name: "Klaviyo" }, deps);

    expect(result).not.toBeNull();
    expect(result!.watch.targets).toContainEqual({ type: "github_release", repo: "klaviyo/openapi" });
    const githubConventionEntry = result!.resolution.find((r) => r.rung === "github_convention")!;
    expect(githubConventionEntry.confidence).toBeGreaterThanOrEqual(0.8);
    // registry rung independently confirmed the org via npm's repository.url
    const registryEntry = result!.resolution.find((r) => r.rung === "registry")!;
    expect(registryEntry.evidence.join(" ")).toContain("klaviyo/klaviyo-api-node");
  });

  it("(ii) search-only third-party-domain candidate is rejected", async () => {
    const fetchFn = makeFakeFetch({
      [NPM("acme-sdk")]: { status: 404 },
      [GURU]: { status: 200, isJson: true, body: {} },
    });
    const search: SearchProvider = {
      search: async () => [{ url: "https://some-random-blog.example/acme-changelog", title: "Acme changelog (unofficial mirror)" }],
    };
    const deps: ResolveDeps = { fetchFn, search, registry: fakeRegistry() };

    const result = await resolveVendorAuto({ packageName: "acme-sdk", ecosystem: "npm", name: "Acme" }, deps);

    expect(result).toBeNull();
  });

  it("(iii) two-rung agreement on the same URL beats a single-rung candidate", async () => {
    const domain = "acme.example";
    const openapiUrl = wellKnown(domain, "/openapi.json");
    const fetchFn = makeFakeFetch({
      [NPM("acme-sdk")]: { status: 404 },
      [GURU]: { status: 200, isJson: true, body: {} },
      [wellKnown(domain, "/openapi.json")]: { status: 200, body: "{}" },
      [wellKnown(domain, "/openapi.yaml")]: { status: 200, body: "openapi: 3.0.0" },
    });
    const search: SearchProvider = {
      search: async (query: string) => (query.includes("openapi") ? [{ url: openapiUrl, title: "Acme OpenAPI spec" }] : []),
    };
    const deps: ResolveDeps = { fetchFn, search, registry: fakeRegistry() };

    const result = await resolveVendorAuto({ packageName: "acme-sdk", ecosystem: "npm", name: "Acme", homepage: `https://${domain}` }, deps);

    expect(result).not.toBeNull();
    expect(result!.vendor.openapi_url).toBe(openapiUrl);
    const wellknownEntry = result!.resolution.find((r) => r.rung === "wellknown")!;
    const searchEntry = result!.resolution.find((r) => r.rung === "search")!;
    // Both rungs' entries should report the confidence of the winning (2-rung) candidate,
    // which must exceed what either rung could achieve alone (wellknown alone: 0.3+0.3=0.6).
    expect(wellknownEntry.confidence).toBeGreaterThan(0.6);
    expect(searchEntry.confidence).toBeGreaterThan(0.6);
  });

  it("(iv) total miss returns null, with every rung actually attempted", async () => {
    const calls: string[] = [];
    const fetchFn = makeFakeFetch(
      {
        [NPM("nope-pkg")]: { status: 404 },
        [GURU]: { status: 200, isJson: true, body: {} },
      },
      calls
    );
    const searchCalls: string[] = [];
    const search: SearchProvider = {
      search: async (query: string) => {
        searchCalls.push(query);
        return [];
      },
    };
    const deps: ResolveDeps = { fetchFn, search, registry: fakeRegistry() };

    const result = await resolveVendorAuto({ packageName: "nope-pkg", ecosystem: "npm", name: "Nope" }, deps);

    expect(result).toBeNull();
    expect(calls).toContain(NPM("nope-pkg"));
    expect(calls).toContain(GURU);
    expect(calls.some((u) => u.startsWith("https://api.github.com/repos/nope/"))).toBe(true);
    expect(calls.some((u) => u.startsWith("https://nope-pkg.com/") || u.startsWith("https://nope.com/"))).toBe(true);
    expect(searchCalls.length).toBe(2);
  });

  it("(v) a pack match short-circuits to the pack's targets without any network calls", async () => {
    const calls: string[] = [];
    const fetchFn = makeFakeFetch({}, calls);
    const pack: Pack = {
      id: "stripe",
      display_name: "Stripe",
      homepage: "https://stripe.com",
      openapi_url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
      packages: { npm: ["stripe"] },
      import_patterns: { js: ["require('stripe')"] },
      watch: [{ type: "openapi", url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json" }],
    };
    const registry = fakeRegistry({ byPackage: (eco, name) => (eco === "npm" && name === "stripe" ? pack : undefined) });
    const deps: ResolveDeps = { fetchFn, search: null, registry };

    const result = await resolveVendorAuto({ packageName: "stripe", ecosystem: "npm" }, deps);

    expect(result).not.toBeNull();
    expect(result!.vendor.id).toBe("stripe");
    expect(result!.vendor.kind).toBe("pack");
    expect(result!.watch.targets).toEqual(pack.watch);
    expect(result!.resolution).toEqual([{ rung: "pack", confidence: 1, evidence: [expect.stringContaining("stripe")] }]);
    expect(calls.length).toBe(0);
  });

  describe("boundary cases", () => {
    it("throws a typed ResolveInputError for completely empty input", async () => {
      const deps: ResolveDeps = { fetchFn: makeFakeFetch({}), search: null, registry: fakeRegistry() };
      await expect(resolveVendorAuto({}, deps)).rejects.toThrow(ResolveInputError);
      await expect(resolveVendorAuto({ packageName: "   " }, deps)).rejects.toThrow(ResolveInputError);
    });

    it("records a rung's network failure as evidence instead of throwing", async () => {
      const fetchFn = makeFakeFetch({
        [NPM("flaky-pkg")]: "network-error",
        [GURU]: { status: 200, isJson: true, body: {} },
      });
      const deps: ResolveDeps = { fetchFn, search: null, registry: fakeRegistry() };

      await expect(resolveVendorAuto({ packageName: "flaky-pkg", ecosystem: "npm", name: "Flaky" }, deps)).resolves.not.toThrow();
      const result = await resolveVendorAuto({ packageName: "flaky-pkg", ecosystem: "npm", name: "Flaky" }, deps);
      expect(result).toBeNull();
    });

    it("a rung that rejects the returned promise is still recorded, not thrown", async () => {
      const throwingFetch = (async () => {
        throw new Error("connection reset");
      }) as unknown as typeof fetch;
      const deps: ResolveDeps = { fetchFn: throwingFetch, search: null, registry: fakeRegistry() };

      await expect(resolveVendorAuto({ packageName: "whatever", ecosystem: "npm", name: "Whatever" }, deps)).resolves.toBeNull();
    });

    it("slugify handles weird vendor names deterministically", () => {
      expect(slugify("Ac + Me!!! Corp")).toBe("ac-me-corp");
      expect(slugify("@scope/pkg-name")).toBe("scope-pkg-name");
      expect(slugify("  Multiple   Spaces  ")).toBe("multiple-spaces");
      expect(slugify("")).toMatch(/^vendor-[0-9a-f]{8}$/);
      expect(slugify("北京")).toMatch(/^vendor-[0-9a-f]{8}$/);
      expect(slugify("北京")).toBe(slugify("北京")); // deterministic
      expect(slugify("!!!")).toMatch(/^vendor-[0-9a-f]{8}$/);
    });
  });
});
