import { describe, it, expect } from "vitest";
import { resolveVendorAuto, slugify, ResolveInputError } from "../src/resolve.js";
import type { ResolveDeps, SearchProvider } from "../src/resolve.js";
import type { Pack, PackRegistry } from "../src/packs.js";
import type { Vendor } from "../src/types.js";

type FakeRoute = { status: number; body?: unknown; isJson?: boolean; contentType?: string } | "network-error";

function makeFakeFetch(routes: Record<string, FakeRoute>, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const route = routes[url];
    if (route === "network-error") throw new Error("simulated network failure");
    if (!route) return new Response(null, { status: 404 });
    if (route.isJson) {
      return new Response(JSON.stringify(route.body), { status: route.status, headers: { "content-type": route.contentType ?? "application/json" } });
    }
    const headers = route.contentType ? { "content-type": route.contentType } : undefined;
    return new Response(typeof route.body === "string" ? route.body : "", { status: route.status, headers });
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

  it("(iii) two-rung agreement is accepted where neither rung alone would be (no domain verification available)", async () => {
    // No homepage given anywhere, and the registry rung finds nothing, so confirmedDomain stays
    // null for this whole resolution: neither wellknown's nor search's hit on beta.com can be
    // domain-verified. This isolates the pure "rungsInvolved.length >= 2" acceptance path from
    // domain verification, and demonstrates it as an accept/reject boundary rather than a magic
    // confidence number: identical inputs, minus the second rung, must flip the outcome to null.
    const openapiUrl = wellKnown("beta.com", "/openapi.json");
    const fetchFnBase: Record<string, FakeRoute> = {
      [NPM("beta-sdk")]: { status: 404 },
      [GURU]: { status: 200, isJson: true, body: {} },
      [openapiUrl]: { status: 200, body: "{}" },
    };

    const twoRungSearch: SearchProvider = {
      search: async (query: string) => (query.includes("openapi") ? [{ url: openapiUrl, title: "Beta OpenAPI spec" }] : []),
    };
    const twoRungResult = await resolveVendorAuto(
      { packageName: "beta-sdk", ecosystem: "npm", name: "Beta" },
      { fetchFn: makeFakeFetch(fetchFnBase), search: twoRungSearch, registry: fakeRegistry() }
    );
    expect(twoRungResult).not.toBeNull();
    expect(twoRungResult!.vendor.openapi_url).toBe(openapiUrl);

    const singleRungResult = await resolveVendorAuto(
      { packageName: "beta-sdk", ecosystem: "npm", name: "Beta" },
      { fetchFn: makeFakeFetch(fetchFnBase), search: null, registry: fakeRegistry() }
    );
    expect(singleRungResult).toBeNull();
  });

  describe("(Finding 1) PyPI registry rung end-to-end", () => {
    it("resolves via PyPI info.home_page / project_urls (real key casing)", async () => {
      const PYPI = (pkg: string) => `https://pypi.org/pypi/${pkg}/json`;
      const fetchFn = makeFakeFetch({
        [PYPI("acme-py")]: {
          status: 200,
          isJson: true,
          // Real shape verified live against https://pypi.org/pypi/stripe/json: info.home_page is
          // frequently null, and the real signal lives in info.project_urls with LOWERCASE keys
          // ("homepage", "source") — not the title-cased keys a naive implementation might assume.
          body: {
            info: {
              home_page: null,
              project_urls: {
                homepage: "https://acme.io",
                source: "https://github.com/acmeorg/acme-python",
                issues: "https://github.com/acmeorg/acme-python/issues",
              },
            },
          },
        },
        [GURU]: { status: 200, isJson: true, body: {} },
      });
      const deps: ResolveDeps = { fetchFn, search: null, registry: fakeRegistry() };

      const result = await resolveVendorAuto({ packageName: "acme-py", ecosystem: "pypi", name: "AcmePy" }, deps);

      expect(result).not.toBeNull();
      expect(result!.vendor.homepage).toBe("https://acme.io");
      expect(result!.vendor.github_repo).toBe("acmeorg/acme-python");
      expect(result!.watch.targets).toContainEqual({ type: "page", url: "https://acme.io", detection: "semantic" });
      const registryEntry = result!.resolution.find((r) => r.rung === "registry")!;
      expect(registryEntry.evidence.join(" ")).toContain("acmeorg/acme-python");
    });
  });

  describe("(Finding 2 + 3a) apis.guru directory rung", () => {
    it("a lone directory hit whose apis.guru KEY equals the resolved vendor domain is accepted as domain-verified", async () => {
      const swaggerUrl = "https://api.apis.guru/v2/specs/acme-corp.io/1.2.3/openapi.json";
      const guruBody = {
        "acme-corp.io": {
          preferred: "1.2.3",
          versions: {
            "1.2.3": {
              swaggerUrl,
              swaggerYamlUrl: "https://api.apis.guru/v2/specs/acme-corp.io/1.2.3/openapi.yaml",
            },
          },
        },
      };
      const routes: Record<string, FakeRoute> = {
        [NPM("acme-directory-sdk")]: { status: 404 },
        [GURU]: { status: 200, isJson: true, body: guruBody },
      };

      const verified = await resolveVendorAuto(
        { packageName: "acme-directory-sdk", ecosystem: "npm", name: "AcmeCorp", homepage: "https://acme-corp.io" },
        { fetchFn: makeFakeFetch(routes), search: null, registry: fakeRegistry() }
      );
      expect(verified).not.toBeNull();
      expect(verified!.vendor.openapi_url).toBe(swaggerUrl);
      expect(verified!.watch.targets).toContainEqual({ type: "openapi", url: swaggerUrl });

      // Same directory entry, but nothing anchors the vendor domain to "acme-corp.io" this time
      // (no homepage given, and the guessed vendorSlug-based domain doesn't match the guru key) —
      // the identical directory hit is now unverified and alone, so it is rejected.
      const unverified = await resolveVendorAuto(
        { packageName: "acme-directory-sdk", ecosystem: "npm", name: "AcmeCorp" },
        { fetchFn: makeFakeFetch(routes), search: null, registry: fakeRegistry() }
      );
      expect(unverified).toBeNull();
    });
  });

  describe("(Finding 3b) search-only rejection restated", () => {
    it("a lone search-rung candidate on an unconfirmed third-party domain is rejected regardless of its baseScore", async () => {
      const fetchFn = makeFakeFetch({
        [NPM("acme-sdk")]: { status: 404 },
        [GURU]: { status: 200, isJson: true, body: {} },
      });
      const search: SearchProvider = {
        search: async () => [{ url: "https://some-random-blog.example/acme-changelog", title: "Acme changelog (unofficial mirror)" }],
      };
      const result = await resolveVendorAuto({ packageName: "acme-sdk", ecosystem: "npm", name: "Acme" }, { fetchFn, search, registry: fakeRegistry() });
      expect(result).toBeNull();
    });
  });

  describe("(Finding 4) subdomain-aware domain matching", () => {
    const baseRoutes: Record<string, FakeRoute> = {
      [NPM("stripe-test-pkg")]: { status: 404 },
      [GURU]: { status: 200, isJson: true, body: {} },
    };
    const searchFor = (url: string): SearchProvider => ({
      search: async (query: string) => (query.includes("changelog") ? [{ url, title: "hit" }] : []),
    });
    const resolve = (url: string) =>
      resolveVendorAuto(
        { packageName: "stripe-test-pkg", ecosystem: "npm", name: "Stripe", homepage: "https://stripe.com" },
        { fetchFn: makeFakeFetch(baseRoutes), search: searchFor(url), registry: fakeRegistry() }
      );

    it("docs.stripe.com verifies as a subdomain of stripe.com -> accepted", async () => {
      const url = "https://docs.stripe.com/changelog";
      const result = await resolve(url);
      expect(result).not.toBeNull();
      expect(result!.vendor.changelog_url).toBe(url);
    });

    it("notstripe.com does NOT verify against stripe.com -> rejected", async () => {
      const result = await resolve("https://notstripe.com/changelog");
      expect(result).toBeNull();
    });

    it("evil-stripe.com.attacker.io does NOT verify against stripe.com -> rejected", async () => {
      const result = await resolve("https://evil-stripe.com.attacker.io/changelog");
      expect(result).toBeNull();
    });
  });

  describe("(Finding 6) github_convention releases parse failure", () => {
    it("records a malformed releases-JSON body in evidence instead of silently swallowing it", async () => {
      // A wellknown hit on the vendor's own confirmed homepage domain guarantees an overall
      // non-null result (so `resolution` is populated) independent of what github_convention
      // finds — isolating the assertion to that one rung's evidence.
      const fetchFn = makeFakeFetch({
        [NPM("gamma-sdk")]: { status: 404 },
        [GURU]: { status: 200, isJson: true, body: {} },
        [GH_REPO("gamma", "openapi")]: { status: 200, isJson: true, body: { id: 1, full_name: "gamma/openapi" } },
        [GH_RELEASES("gamma", "openapi")]: { status: 200, body: "not valid json{" },
        [wellKnown("gamma.io", "/changelog")]: { status: 200, body: "<html>v1</html>", contentType: "text/html" },
      });
      const deps: ResolveDeps = { fetchFn, search: null, registry: fakeRegistry() };

      const result = await resolveVendorAuto({ packageName: "gamma-sdk", ecosystem: "npm", name: "Gamma", homepage: "https://gamma.io" }, deps);

      expect(result).not.toBeNull();
      const githubConventionEntry = result!.resolution.find((r) => r.rung === "github_convention")!;
      expect(githubConventionEntry.evidence.join(" ")).toContain("could not be parsed");
    });
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

  it("well-known probe rejects an HTML page served at an openapi path (parked-domain false positive)", async () => {
    const domain = "parked.example";
    const fetchFn = makeFakeFetch({
      [NPM("parked-sdk")]: { status: 404 },
      [GURU]: { status: 200, isJson: true, body: {} },
      [wellKnown(domain, "/openapi.json")]: { status: 200, body: "<html><body>Domain for sale</body></html>", contentType: "text/html" },
    });
    const deps: ResolveDeps = { fetchFn, search: null, registry: fakeRegistry() };

    const result = await resolveVendorAuto({ packageName: "parked-sdk", ecosystem: "npm", name: "Parked", homepage: `https://${domain}` }, deps);

    expect(result).toBeNull();
  });

  it("well-known probe accepts a real HTML changelog page but not an HTML openapi.json", async () => {
    const domain = "realvendor.example";
    const fetchFn = makeFakeFetch({
      [NPM("real-sdk")]: { status: 404 },
      [GURU]: { status: 200, isJson: true, body: {} },
      [wellKnown(domain, "/openapi.json")]: { status: 200, body: "<html>not a spec</html>", contentType: "text/html" },
      [wellKnown(domain, "/changelog")]: { status: 200, body: "<html>v2.0 released</html>", contentType: "text/html" },
    });
    const deps: ResolveDeps = { fetchFn, search: null, registry: fakeRegistry() };

    const result = await resolveVendorAuto({ packageName: "real-sdk", ecosystem: "npm", name: "RealVendor", homepage: `https://${domain}` }, deps);

    expect(result).not.toBeNull();
    expect(result!.vendor.openapi_url).toBeUndefined();
    expect(result!.vendor.changelog_url).toBe(wellKnown(domain, "/changelog"));
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
