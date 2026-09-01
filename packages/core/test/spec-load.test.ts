import { describe, it, expect } from "vitest";
import { loadSpec, resolveRef, flattenAllOf, normalizeNullable } from "../src/spec/load.js";

const V3_JSON = JSON.stringify({
  openapi: "3.0.0", info: { title: "t", version: "2024-01-01" },
  paths: { "/v1/charges": { get: { operationId: "listCharges" }, parameters: [] } },
  components: { schemas: { Charge: { type: "object", properties: { id: { type: "string" } } } },
                securitySchemes: { api_key: { type: "http", scheme: "bearer" } } },
});
const V2_YAML = `
swagger: "2.0"
info: { title: t, version: "1.0" }
paths:
  /pets:
    get: { operationId: listPets }
definitions:
  Pet: { type: object }
`;

describe("loadSpec", () => {
  it("parses v3 JSON", () => {
    const s = loadSpec(V3_JSON);
    expect(s.version).toBe("2024-01-01");
    expect(Object.keys(s.paths["/v1/charges"])).toEqual(["get"]);
    expect(s.schemas.Charge).toBeDefined();
    expect(s.securitySchemes.api_key).toBeDefined();
  });
  it("parses swagger 2 YAML, mapping definitions to schemas", () => {
    const s = loadSpec(V2_YAML);
    expect(s.paths["/pets"].get).toBeDefined();
    expect(s.schemas.Pet).toBeDefined();
  });
  it("throws on garbage", () => {
    expect(() => loadSpec("]]not a spec[[")).toThrow(/unparsable/);
  });
  it("throws on parseable non-spec", () => {
    expect(() => loadSpec('{"hello": 1}')).toThrow(/unparsable/);
  });
  it("handles spec with zero paths", () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "empty", version: "1.0.0" },
      paths: {},
    });
    const s = loadSpec(spec);
    expect(s.paths).toEqual({});
    expect(s.version).toBe("1.0.0");
  });
  it("handles empty string", () => {
    expect(() => loadSpec("")).toThrow(/unparsable/);
  });
  it("lowercases HTTP methods in paths", () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "t", version: "1.0.0" },
      paths: {
        "/test": {
          get: { summary: "Get test" },
          POST: { summary: "Post test" },
          parameters: [{ name: "test" }],
        },
      },
    });
    const s = loadSpec(spec);
    expect(s.paths["/test"].get).toBeDefined();
    expect(s.paths["/test"].post).toBeDefined();
    expect(s.paths["/test"].parameters).toBeUndefined();
  });
});

describe("resolveRef", () => {
  it("walks a ref path", () => {
    const raw = JSON.parse(V3_JSON);
    expect(resolveRef(raw, "#/components/schemas/Charge")).toMatchObject({ type: "object" });
    expect(resolveRef(raw, "#/components/schemas/Nope")).toBeUndefined();
  });
  it("returns undefined for invalid ref paths", () => {
    const raw = { components: { schemas: { Test: {} } } };
    expect(resolveRef(raw, "#/invalid/path")).toBeUndefined();
  });
  it("handles swagger 2 definitions path", () => {
    const raw = { definitions: { Pet: { type: "object" } } };
    expect(resolveRef(raw, "#/definitions/Pet")).toMatchObject({ type: "object" });
  });
});

describe("flattenAllOf", () => {
  it("merges allOf of $ref and inline object", () => {
    const raw = {
      components: {
        schemas: {
          Base: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      },
    };
    const schema = {
      allOf: [
        { $ref: "#/components/schemas/Base" },
        { properties: { name: { type: "string" } }, required: ["name"] },
      ],
    };
    const result = flattenAllOf(schema, raw);
    expect(result).toMatchObject({
      type: "object",
      properties: expect.objectContaining({ id: { type: "string" }, name: { type: "string" } }),
      required: expect.arrayContaining(["id", "name"]),
    });
  });

  it("respects depth cap of 8", () => {
    const createNested = (depth: number): unknown => {
      if (depth === 0) {
        return { type: "string" };
      }
      return { allOf: [createNested(depth - 1)] };
    };
    const raw = {};
    const schema = createNested(10);
    const result = flattenAllOf(schema, raw, 8);
    expect(result).toBeDefined();
  });

  it("returns non-objects as-is", () => {
    const result = flattenAllOf("string", {});
    expect(result).toBe("string");
    const result2 = flattenAllOf(42, {});
    expect(result2).toBe(42);
    const result3 = flattenAllOf(null, {});
    expect(result3).toBeNull();
  });

  it("handles nested allOf", () => {
    const raw = {
      components: {
        schemas: {
          A: { properties: { a: { type: "string" } } },
          B: { allOf: [{ $ref: "#/components/schemas/A" }, { properties: { b: { type: "number" } } }] },
        },
      },
    };
    const schema = {
      allOf: [
        { $ref: "#/components/schemas/B" },
        { properties: { c: { type: "boolean" } } },
      ],
    };
    const result = flattenAllOf(schema, raw);
    expect(result).toMatchObject({
      properties: expect.objectContaining({
        a: { type: "string" },
        b: { type: "number" },
        c: { type: "boolean" },
      }),
    });
  });

  it("merges properties and required from all branches", () => {
    const schema = {
      allOf: [
        { properties: { x: { type: "string" } }, required: ["x"] },
        { properties: { y: { type: "number" } }, required: ["y"] },
        { properties: { z: { type: "boolean" } } },
      ],
    };
    const result = flattenAllOf(schema, {});
    expect(result).toMatchObject({
      properties: expect.objectContaining({
        x: { type: "string" },
        y: { type: "number" },
        z: { type: "boolean" },
      }),
      required: expect.arrayContaining(["x", "y"]),
    });
  });

  it("later branches win on scalar conflict", () => {
    const schema = {
      allOf: [
        { type: "string", minLength: 1 },
        { type: "number", minLength: 5 },
      ],
    };
    const result = flattenAllOf(schema, {});
    expect(result.type).toBe("number");
    expect(result.minLength).toBe(5);
  });
});

describe("normalizeNullable", () => {
  it("converts OpenAPI 3.1 nullable array to 3.0 convention", () => {
    const schema = { type: ["string", "null"] };
    const result = normalizeNullable(schema);
    expect(result).toMatchObject({ type: "string", nullable: true });
  });

  it("converts type array with null for other types", () => {
    const schema = { type: ["number", "null"] };
    const result = normalizeNullable(schema);
    expect(result).toMatchObject({ type: "number", nullable: true });
  });

  it("leaves arrays with >2 types unchanged", () => {
    const schema = { type: ["string", "number", "null"] };
    const result = normalizeNullable(schema);
    expect(result).toEqual({ type: ["string", "number", "null"] });
  });

  it("leaves arrays without null unchanged", () => {
    const schema = { type: ["string", "integer"] };
    const result = normalizeNullable(schema);
    expect(result).toEqual({ type: ["string", "integer"] });
  });

  it("passes non-object input through", () => {
    expect(normalizeNullable("string")).toBe("string");
    expect(normalizeNullable(42)).toBe(42);
    expect(normalizeNullable(null)).toBeNull();
  });

  it("preserves other properties in schema", () => {
    const schema = { type: ["string", "null"], description: "A nullable string", minLength: 1 };
    const result = normalizeNullable(schema);
    expect(result).toMatchObject({
      type: "string",
      nullable: true,
      description: "A nullable string",
      minLength: 1,
    });
  });
});
