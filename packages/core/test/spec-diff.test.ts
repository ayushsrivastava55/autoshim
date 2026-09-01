import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSpec } from "../src/spec/load.js";
import { diffSpecs, classifyDiff, diffEntities } from "../src/spec/diff.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const spec = (f: string) => loadSpec(readFileSync(join(root, "fixtures/specs", f), "utf8"));

describe("diffSpecs on petstore pair", () => {
  const d = diffSpecs(spec("petstore-a.json"), spec("petstore-b.json"));
  it("finds removed and added paths", () => {
    expect(d.specDiff.removedPaths).toContain("GET /v1/stores");
    expect(d.specDiff.addedPaths).toContain("GET /v1/orders");
  });
  it("finds property removal via $ref into components (both get and post on /v1/pets)", () => {
    const pets = d.specDiff.changedOperations.filter((o) => o.path === "/v1/pets");
    expect(pets.length).toBeGreaterThanOrEqual(2);
    const kinds = pets.flatMap((o) => o.changes).map((c) => `${c.field}:${c.kind}`);
    expect(kinds).toContain("Pet.tag:removed");
    expect(kinds).toContain("Pet.status:enum_removed");
  });
  it("finds param type change with from/to", () => {
    const get = d.specDiff.changedOperations.find((o) => o.path === "/v1/pets" && o.method === "get")!;
    const tc = get.changes.find((c) => c.kind === "type_change")!;
    expect(tc.field).toBe("limit");
    expect(tc.from).toBe("integer");
    expect(tc.to).toBe("string");
  });
  it("finds deprecation flip", () => {
    expect(d.deprecatedOps).toContainEqual({ method: "get", path: "/v1/pets/{id}" });
  });
  it("classifies as breaking at 0.95", () => {
    expect(classifyDiff(d)).toEqual({ classification: "breaking", breaking_confidence: 0.95 });
  });
  it("derives entities", () => {
    const ents = diffEntities(d);
    expect(ents).toContainEqual({ type: "endpoint", name: "GET /v1/stores" });
    expect(ents).toContainEqual({ type: "resource", name: "Pet" });
    expect(ents).toContainEqual({ type: "param", name: "limit" });
  });
  it("every change carries a stable kebab-case rule id", () => {
    const changes = d.specDiff.changedOperations.flatMap((o) => o.changes);
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) {
      expect(c.rule).toMatch(/^[a-z]+(-[a-z0-9]+)*$/);
    }
  });
});

describe("classification tiers", () => {
  it("identical specs -> docs_only; additive-only -> additive; deprecation-only -> deprecation", () => {
    const a = spec("petstore-a.json");
    expect(classifyDiff(diffSpecs(a, a)).classification).toBe("docs_only");
    const bAdd = structuredClone(a); (bAdd.paths as any)["/v1/new"] = { get: {} };
    expect(classifyDiff(diffSpecs(a, bAdd)).classification).toBe("additive");
    const bDep = structuredClone(a); (bDep.paths as any)["/v1/pets"].get.deprecated = true;
    expect(classifyDiff(diffSpecs(a, bDep)).classification).toBe("deprecation");
  });

  // AMENDMENT: v1 has no rename detection. A removed path + an added path with an
  // identical method set (even a near-identical one) is reported as plain
  // removal-and-addition, never fused into a single "renamed" change.
  it("no rename detection: removed+added path pair is reported as removal+addition, not renamed", () => {
    const a = spec("petstore-a.json");
    const b = structuredClone(a);
    (b.paths as any)["/v1/pets_list"] = (b.paths as any)["/v1/pets"];
    delete (b.paths as any)["/v1/pets"];
    const d = diffSpecs(a, b);
    expect(d.specDiff.removedPaths).toContain("GET /v1/pets");
    expect(d.specDiff.removedPaths).toContain("POST /v1/pets");
    expect(d.specDiff.addedPaths).toContain("GET /v1/pets_list");
    expect(d.specDiff.addedPaths).toContain("POST /v1/pets_list");
    const renamed = d.specDiff.changedOperations.flatMap((o) => o.changes).find((c) => c.kind === "renamed");
    expect(renamed).toBeUndefined();
  });
});

// AMENDMENT tests: direction-aware classification, readOnly/writeOnly guards, and
// negotiated-field polarity (OpenAPI 3.0.3 Schema Object, readOnly/writeOnly fixed fields:
// https://spec.openapis.org/oas/v3.0.3#schema-object — "If the property is marked as
// readOnly being true and is in the required list, the required will take effect on the
// response only" (and symmetrically writeOnly / request only); see also
// docs/references/oasdiff-taxonomy.md "Contravariance rules").
describe("direction-aware classification (amendment)", () => {
  function withResponseSchema(schema: unknown) {
    return {
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: { "/v1/things": { get: { operationId: "getThing", responses: { "200": { content: { "application/json": { schema } } } } } } },
      components: { schemas: {} },
    };
  }
  function withRequestSchema(schema: unknown) {
    return {
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: { "/v1/things": { post: { operationId: "createThing", requestBody: { content: { "application/json": { schema } } } } } },
      components: { schemas: {} },
    };
  }

  it("readOnly response property becoming required is not breaking (negotiated-field polarity)", () => {
    const a = loadSpec(JSON.stringify(withResponseSchema({
      type: "object", properties: { id: { type: "string", readOnly: true } },
    })));
    const b = loadSpec(JSON.stringify(withResponseSchema({
      type: "object", required: ["id"], properties: { id: { type: "string", readOnly: true } },
    })));
    const d = diffSpecs(a, b);
    const kinds = d.specDiff.changedOperations.flatMap((o) => o.changes).map((c) => c.kind);
    // response-direction added_required is informational, never breaking
    expect(classifyDiff(d).classification).not.toBe("breaking");
    if (kinds.includes("added_required")) {
      const c = d.specDiff.changedOperations.flatMap((o) => o.changes).find((x) => x.kind === "added_required")!;
      expect(c.rule).toBe("response-property-added-required");
    }
  });

  it("writeOnly request property becoming required IS breaking (mirror of readOnly guard)", () => {
    const a = loadSpec(JSON.stringify(withRequestSchema({
      type: "object", properties: { password: { type: "string", writeOnly: true } },
    })));
    const b = loadSpec(JSON.stringify(withRequestSchema({
      type: "object", required: ["password"], properties: { password: { type: "string", writeOnly: true } },
    })));
    const d = diffSpecs(a, b);
    expect(classifyDiff(d).classification).toBe("breaking");
    const c = d.specDiff.changedOperations.flatMap((o) => o.changes).find((x) => x.kind === "added_required")!;
    expect(c.rule).toBe("request-property-added-required");
  });

  it("enum value removed from a response-only schema is not breaking; from a request-only schema it is", () => {
    const aResp = loadSpec(JSON.stringify(withResponseSchema({ type: "object", properties: { state: { type: "string", enum: ["a", "b"] } } })));
    const bResp = loadSpec(JSON.stringify(withResponseSchema({ type: "object", properties: { state: { type: "string", enum: ["a"] } } })));
    expect(classifyDiff(diffSpecs(aResp, bResp)).classification).not.toBe("breaking");

    const aReq = loadSpec(JSON.stringify(withRequestSchema({ type: "object", properties: { state: { type: "string", enum: ["a", "b"] } } })));
    const bReq = loadSpec(JSON.stringify(withRequestSchema({ type: "object", properties: { state: { type: "string", enum: ["a"] } } })));
    expect(classifyDiff(diffSpecs(aReq, bReq)).classification).toBe("breaking");
  });

  it("mutually-recursive $ref schemas diff without hanging, comparing circular refs by identity", () => {
    const build = (tagged: boolean) => ({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        "/v1/nodes": {
          post: { operationId: "createNode", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/NodeA" } } } } },
        },
      },
      components: {
        schemas: {
          NodeA: {
            type: "object",
            properties: tagged
              ? { child: { $ref: "#/components/schemas/NodeB" }, tag: { type: "string" } }
              : { child: { $ref: "#/components/schemas/NodeB" } },
          },
          NodeB: { type: "object", properties: { parent: { $ref: "#/components/schemas/NodeA" } } },
        },
      },
    });
    const a = loadSpec(JSON.stringify(build(true)));
    const b = loadSpec(JSON.stringify(build(false)));
    const t0 = performance.now();
    const d = diffSpecs(a, b);
    expect(performance.now() - t0).toBeLessThan(1000);
    // NodeA.tag removal is found despite the NodeA <-> NodeB reference cycle.
    const kinds = d.specDiff.changedOperations.flatMap((o) => o.changes).map((c) => `${c.field}:${c.kind}`);
    expect(kinds).toContain("NodeA.tag:removed");
  });
});

// Fix round 1 (code review): the components pass must compute each shared schema's
// diff PER DIRECTION actually used at each site, not once under a hardcoded
// direction with the rule id merely relabeled afterward — because the
// readOnly/writeOnly guard decision itself is direction-dependent, not just the
// rule id.
describe("components-pass direction bug (fix round 1, reviewer repros)", () => {
  function responseOnlySpec(thingSchema: unknown) {
    return {
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        "/v1/things": {
          get: { operationId: "getThing", responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Thing" } } } } } },
        },
      },
      components: { schemas: { Thing: thingSchema } },
    };
  }

  it("readOnly property removed from a component used ONLY in a response is breaking (response-property-removed)", () => {
    const a = loadSpec(JSON.stringify(responseOnlySpec({
      type: "object", properties: { id: { type: "string", readOnly: true }, name: { type: "string" } },
    })));
    const b = loadSpec(JSON.stringify(responseOnlySpec({
      type: "object", properties: { name: { type: "string" } },
    })));
    const d = diffSpecs(a, b);
    const changes = d.specDiff.changedOperations.flatMap((o) => o.changes);
    expect(changes).toContainEqual({ field: "Thing.id", kind: "removed", rule: "response-property-removed" });
    expect(classifyDiff(d).classification).toBe("breaking");
  });

  it("writeOnly property removed from a component used ONLY in a response emits NO change (guarded)", () => {
    const a = loadSpec(JSON.stringify(responseOnlySpec({
      type: "object", properties: { secret: { type: "string", writeOnly: true }, name: { type: "string" } },
    })));
    const b = loadSpec(JSON.stringify(responseOnlySpec({
      type: "object", properties: { name: { type: "string" } },
    })));
    const d = diffSpecs(a, b);
    const changes = d.specDiff.changedOperations.flatMap((o) => o.changes);
    expect(changes.find((c) => c.field === "Thing.secret")).toBeUndefined();
    expect(classifyDiff(d).classification).not.toBe("breaking");
  });
});

describe("response-enum-value-added (fix round 1, CRITICAL 2)", () => {
  it("a new enum value appearing in a response schema is breaking with rule response-enum-value-added", () => {
    const build = (values: string[]) => ({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        "/v1/things": {
          get: { operationId: "getThing", responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { state: { type: "string", enum: values } } } } } } } },
        },
      },
      components: { schemas: {} },
    });
    const a = loadSpec(JSON.stringify(build(["a", "b"])));
    const b = loadSpec(JSON.stringify(build(["a", "b", "c"])));
    const d = diffSpecs(a, b);
    const changes = d.specDiff.changedOperations.flatMap((o) => o.changes);
    expect(changes).toContainEqual({ field: "state", kind: "type_change", from: "a,b", to: "a,b,c", rule: "response-enum-value-added" });
    expect(classifyDiff(d).classification).toBe("breaking");
  });
});

describe("remaining amendment tests (fix round 1, IMPORTANT 4)", () => {
  it("OAS 3.1 type:[T,null] and OAS 3.0 nullable:true are equivalent: zero diff", () => {
    const build = (nullable311: boolean) => ({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        "/v1/things": {
          get: {
            operationId: "getThing",
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        value: nullable311 ? { type: ["string", "null"] } : { type: "string", nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: { schemas: {} },
    });
    const a = loadSpec(JSON.stringify(build(true)));
    const b = loadSpec(JSON.stringify(build(false)));
    const d = diffSpecs(a, b);
    expect(d.specDiff.changedOperations).toEqual([]);
    expect(classifyDiff(d).classification).toBe("docs_only");
  });

  it("a removal confined to a 404 response is not breaking (v1 does not inspect non-2xx responses)", () => {
    const build = (withCode: boolean) => ({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        "/v1/things": {
          get: {
            operationId: "getThing",
            responses: {
              "200": { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } } } } } },
              "404": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: withCode ? { message: { type: "string" }, code: { type: "string" } } : { message: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: { schemas: {} },
    });
    const a = loadSpec(JSON.stringify(build(true)));
    const b = loadSpec(JSON.stringify(build(false)));
    const d = diffSpecs(a, b);
    expect(classifyDiff(d).classification).not.toBe("breaking");
  });
});

describe("response-media-type-removed (fix round 1, IMPORTANT 5)", () => {
  it("schema/content removed from a surviving 2xx status is breaking", () => {
    const a = loadSpec(JSON.stringify({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        "/v1/things": {
          get: { operationId: "getThing", responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } } },
        },
      },
      components: { schemas: {} },
    }));
    const b = loadSpec(JSON.stringify({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        "/v1/things": {
          get: { operationId: "getThing", responses: { "200": { description: "ok" } } },
        },
      },
      components: { schemas: {} },
    }));
    const d = diffSpecs(a, b);
    const changes = d.specDiff.changedOperations.flatMap((o) => o.changes);
    expect(changes).toContainEqual({ field: "status:200", kind: "removed", rule: "response-media-type-removed" });
    expect(classifyDiff(d).classification).toBe("breaking");
  });
});

describe("rule-tagged operation removal / deprecation / security changes (fix round 1, IMPORTANT 3)", () => {
  it("a removed operation gets a rule-tagged operation-removed change alongside the removedPaths string", () => {
    const a = spec("petstore-a.json");
    const d = diffSpecs(a, spec("petstore-b.json"));
    const stores = d.specDiff.changedOperations.find((o) => o.path === "/v1/stores" && o.method === "get");
    expect(stores).toBeDefined();
    expect(stores!.changes).toContainEqual({ field: "", kind: "removed", rule: "operation-removed" });
  });

  it("a deprecation flip gets a rule-tagged operation-deprecated change (non-breaking)", () => {
    const a = spec("petstore-a.json");
    const d = diffSpecs(a, spec("petstore-b.json"));
    const getPet = d.specDiff.changedOperations.find((o) => o.path === "/v1/pets/{id}" && o.method === "get");
    expect(getPet).toBeDefined();
    expect(getPet!.changes).toContainEqual({ field: "deprecated", kind: "type_change", from: "false", to: "true", rule: "operation-deprecated" });
  });

  it("a security scheme change gets a rule-tagged security-scheme-changed change", () => {
    const build = (scheme: string) => ({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: { "/v1/things": { get: { operationId: "getThing" } } },
      components: { schemas: {}, securitySchemes: { apiKey: { type: "apiKey", name: scheme, in: "header" } } },
    });
    const a = loadSpec(JSON.stringify(build("X-Api-Key")));
    const b = loadSpec(JSON.stringify(build("X-Other-Key")));
    const d = diffSpecs(a, b);
    const changes = d.specDiff.changedOperations.flatMap((o) => o.changes);
    expect(changes).toContainEqual({ field: "security", kind: "removed", rule: "security-scheme-changed" });
    expect(classifyDiff(d).classification).toBe("breaking");
  });
});
