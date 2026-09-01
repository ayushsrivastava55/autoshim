import { parse as parseYaml } from "yaml";

export interface NormalizedSpec {
  version: string; // info.version or ""
  paths: Record<string, Record<string, unknown>>; // path -> lowercase method -> operation object
  schemas: Record<string, unknown>; // components.schemas (v3) or definitions (v2)
  securitySchemes: Record<string, unknown>;
  raw: unknown; // full parsed doc (for lazy $ref resolution)
}

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "patch", "options", "head", "trace"]);

/**
 * Parses an OpenAPI 3.x or Swagger 2.0 specification from JSON or YAML text.
 * Tries JSON.parse first for performance (10MB specs), then falls back to YAML parsing.
 * A valid spec must have `paths` and either `openapi` (v3) or `swagger` (v2) fields.
 *
 * @param text - The spec content as a string
 * @returns A normalized spec object
 * @throws Error with message starting with "unparsable spec:" if parsing or validation fails
 *
 * Reference: https://spec.openapis.org/
 */
export function loadSpec(text: string): NormalizedSpec {
  let parsed: unknown;

  // Try JSON parse first (fast path for 10MB GitHub specs)
  try {
    parsed = JSON.parse(text);
  } catch {
    // Fall back to YAML parsing
    try {
      parsed = parseYaml(text);
    } catch {
      throw new Error("unparsable spec: failed to parse as JSON or YAML");
    }
  }

  // Validate spec structure
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("unparsable spec: root must be an object");
  }

  const spec = parsed as Record<string, unknown>;

  // Check for required fields: paths and (openapi or swagger)
  if (!("paths" in spec) || (typeof spec.paths !== "object" || spec.paths === null)) {
    throw new Error("unparsable spec: missing or invalid 'paths' field");
  }

  if (!("openapi" in spec || "swagger" in spec)) {
    throw new Error("unparsable spec: missing 'openapi' or 'swagger' field");
  }

  // Determine version
  const version = spec.info && typeof spec.info === "object" && "version" in spec.info
    ? String((spec.info as Record<string, unknown>).version)
    : "";

  // Normalize paths: filter to HTTP methods, lowercase method names
  const paths: Record<string, Record<string, unknown>> = {};
  const pathsObj = spec.paths as Record<string, unknown>;

  for (const [pathKey, pathValue] of Object.entries(pathsObj)) {
    if (typeof pathValue !== "object" || pathValue === null) {
      continue;
    }

    const normalizedPath: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(pathValue as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (HTTP_METHODS.has(lowerKey)) {
        normalizedPath[lowerKey] = value;
      }
    }

    paths[pathKey] = normalizedPath;
  }

  // Extract schemas from components.schemas (v3) or definitions (v2)
  let schemas: Record<string, unknown> = {};

  if (spec.components && typeof spec.components === "object") {
    const components = spec.components as Record<string, unknown>;
    if (components.schemas && typeof components.schemas === "object") {
      schemas = { ...(components.schemas as Record<string, unknown>) };
    }
  }

  if (spec.definitions && typeof spec.definitions === "object") {
    schemas = { ...(spec.definitions as Record<string, unknown>) };
  }

  // Extract security schemes
  let securitySchemes: Record<string, unknown> = {};

  if (spec.components && typeof spec.components === "object") {
    const components = spec.components as Record<string, unknown>;
    if (components.securitySchemes && typeof components.securitySchemes === "object") {
      securitySchemes = { ...(components.securitySchemes as Record<string, unknown>) };
    }
  }

  if (spec.securityDefinitions && typeof spec.securityDefinitions === "object") {
    securitySchemes = { ...(spec.securityDefinitions as Record<string, unknown>) };
  }

  return {
    version,
    paths,
    schemas,
    securitySchemes,
    raw: parsed,
  };
}

/**
 * Resolves a JSON Pointer reference (like "#/components/schemas/X") in a parsed spec.
 * Returns undefined if the path doesn't exist.
 *
 * Reference: https://tools.ietf.org/html/rfc6901 (JSON Pointer)
 */
export function resolveRef(raw: unknown, ref: string): unknown | undefined {
  if (!ref.startsWith("#/")) {
    return undefined;
  }

  const parts = ref.slice(2).split("/");
  let current = raw;

  for (const part of parts) {
    if (typeof current !== "object" || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Flattens and merges all allOf branches into a single synthesized schema object.
 * - Resolves $ref branches via resolveRef against the raw spec
 * - Merges properties and required arrays (union)
 * - Takes scalar values from branches (later branches win on conflict)
 * - Returns non-objects as-is
 * - Respects depth cap of 8 to prevent infinite recursion
 *
 * Reference: OpenAPI 3.0+ allOf specification:
 * https://spec.openapis.org/oas/v3.0.3#composition-and-inheritance-polymorphism
 */
export function flattenAllOf(schema: unknown, raw: unknown, depth?: number): unknown {
  const maxDepth = depth ?? 8;

  if (maxDepth <= 0) {
    return schema;
  }

  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return schema;
  }

  const schemaObj = schema as Record<string, unknown>;

  if (!("allOf" in schemaObj)) {
    return schema;
  }

  const allOf = schemaObj.allOf;
  if (!Array.isArray(allOf) || allOf.length === 0) {
    return schema;
  }

  const merged: Record<string, unknown> = {};
  const requiredSet = new Set<string>();

  for (const branch of allOf) {
    let resolved = branch;

    // Resolve $ref if present
    if (typeof branch === "object" && branch !== null && !Array.isArray(branch)) {
      const branchObj = branch as Record<string, unknown>;
      if ("$ref" in branchObj && typeof branchObj.$ref === "string") {
        resolved = resolveRef(raw, branchObj.$ref);
        if (resolved === undefined) {
          continue;
        }
      }
    }

    // Recursively flatten nested allOf
    resolved = flattenAllOf(resolved, raw, maxDepth - 1);

    if (typeof resolved !== "object" || resolved === null || Array.isArray(resolved)) {
      continue;
    }

    const resolvedObj = resolved as Record<string, unknown>;

    // Merge properties
    if ("properties" in resolvedObj && typeof resolvedObj.properties === "object" && resolvedObj.properties !== null) {
      const props = resolvedObj.properties as Record<string, unknown>;
      for (const [key, value] of Object.entries(props)) {
        merged.properties = merged.properties || {};
        (merged.properties as Record<string, unknown>)[key] = value;
      }
    }

    // Merge required arrays
    if ("required" in resolvedObj && Array.isArray(resolvedObj.required)) {
      for (const req of resolvedObj.required as unknown[]) {
        if (typeof req === "string") {
          requiredSet.add(req);
        }
      }
    }

    // Copy scalar values (later branches win on conflict)
    for (const [key, value] of Object.entries(resolvedObj)) {
      if (key !== "properties" && key !== "required" && key !== "allOf") {
        merged[key] = value;
      }
    }
  }

  // Add required array if any requirements were collected
  if (requiredSet.size > 0) {
    merged.required = Array.from(requiredSet);
  }

  return merged;
}

/**
 * Normalizes OpenAPI 3.1 nullable type arrays to OpenAPI 3.0 convention.
 * Converts `{ type: ["string", "null"] }` to `{ type: "string", nullable: true }`.
 * Only transforms 2-element arrays where one element is "null"; others are unchanged.
 * Non-object inputs are passed through as-is.
 *
 * Reference: OpenAPI 3.0 nullable:
 * https://spec.openapis.org/oas/v3.0.3#data-types
 * OpenAPI 3.1 type arrays:
 * https://spec.openapis.org/oas/v3.1.0#data-types
 */
export function normalizeNullable(schema: unknown): unknown {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return schema;
  }

  const schemaObj = schema as Record<string, unknown>;

  if (!("type" in schemaObj)) {
    return schema;
  }

  const type = schemaObj.type;

  // Only handle 2-element arrays with "null"
  if (!Array.isArray(type) || type.length !== 2) {
    return schema;
  }

  const hasNull = type.includes("null");
  if (!hasNull) {
    return schema;
  }

  // Extract the non-null type
  const nonNullType = type.find((t) => t !== "null");
  if (typeof nonNullType !== "string") {
    return schema;
  }

  // Create normalized schema with 3.0 convention
  return {
    ...schemaObj,
    type: nonNullType,
    nullable: true,
  };
}
