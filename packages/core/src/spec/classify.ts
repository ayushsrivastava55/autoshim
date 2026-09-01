import type { Classification, OperationChange } from "../types.js";
import type { DiffResult } from "./diff.js";

/**
 * Direction-aware, per-rule breaking table (PRD §10 + amendment).
 *
 * Each entry is data, not a branch in a big if/else: `breaking(rule)` is a single
 * lookup. Rule ids are produced by diff.ts (see buildRule there) and are stable,
 * kebab-case strings so they can be logged, tested, and tuned independently.
 *
 * Grounding:
 * - "removed" is always breaking regardless of direction: oasdiff itself only WARNs
 *   on bare parameter/property removal (impact is statically unknowable), but Autoshim
 *   upgrades this to breaking because the impact scanner confirms real consumer usage
 *   (docs/references/oasdiff-taxonomy.md, "Implications" + "Warning-level").
 * - "added_required" / "type_change" / "enum_removed" are direction-reversed
 *   ("negotiated-field polarity"): breaking when it tightens what a *request* must
 *   satisfy, non-breaking when it only tightens what a *response* promises to
 *   provide (docs/references/oasdiff-taxonomy.md, "Contravariance rules" 1-4).
 * - Parameters only ever live in requests (OpenAPI 3.0.3 Parameter Object has no
 *   response-side equivalent), so every parameter rule is unconditionally breaking.
 */
const ALWAYS_BREAKING_RULES = new Set<string>([
  "request-parameter-removed",
  "request-parameter-added-required",
  "request-parameter-type-changed",
  "request-parameter-enum-value-removed",
  "request-property-removed",
  "response-property-removed",
  "request-property-added-required",
  "request-property-type-changed",
  "request-enum-value-removed",
  "response-status-removed",
  "path-removed",
  "security-requirement-changed",
]);

/** Non-breaking by construction, but named so classification stays a lookup, not a guess. */
const NEVER_BREAKING_RULES = new Set<string>([
  "response-property-added-required",
  "response-property-type-changed",
  "response-enum-value-removed",
  "path-added",
  "operation-added",
]);

export function isBreakingRule(rule: string): boolean {
  if (ALWAYS_BREAKING_RULES.has(rule)) return true;
  if (NEVER_BREAKING_RULES.has(rule)) return false;
  // Unknown rule: fail safe toward "breaking" rather than silently under-reporting —
  // false negatives (missed breakage) are worse than false positives for this product.
  return true;
}

function hasBreakingChange(changes: OperationChange[]): boolean {
  return changes.some((c) => isBreakingRule(c.rule));
}

export function classifyDiff(d: DiffResult): { classification: Classification; breaking_confidence: number } {
  const anyBreakingChange = d.specDiff.changedOperations.some((op) => hasBreakingChange(op.changes));

  if (d.specDiff.removedPaths.length > 0 || anyBreakingChange || d.securityChanged) {
    return { classification: "breaking", breaking_confidence: 0.95 };
  }
  if (d.deprecatedOps.length > 0) {
    return { classification: "deprecation", breaking_confidence: 0.7 };
  }
  if (d.specDiff.addedPaths.length > 0 || d.addedOperations.length > 0) {
    return { classification: "additive", breaking_confidence: 0.5 };
  }
  return { classification: "docs_only", breaking_confidence: 0.9 };
}
