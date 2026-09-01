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
 * - "response-enum-value-added" is the one taxonomy rule with no v1 removed/added_
 *   required/type_change/enum_removed home: a *new* possible response value is a
 *   breaking surprise to a consumer's switch/case even though nothing was removed
 *   (docs/references/oasdiff-taxonomy.md, "Contravariance rules" #4: "added to
 *   response = BREAKING"). diff.ts emits it with `kind: "type_change"` (closest fit
 *   among the frozen SpecChangeKind members) but this rule id, not the kind, drives
 *   severity here.
 * - "operation-removed" / "operation-deprecated" / "security-scheme-changed" mirror
 *   the removedPaths / deprecatedOps / securityChanged flags DiffResult already
 *   carries as its top-level contract; they exist so a consumer reading only
 *   `changedOperations` (e.g. a PR body renderer) sees the full picture without
 *   also cross-referencing those flags. They do not change classifyDiff's own
 *   behavior below, which still branches on the flags directly.
 * - "response-media-type-removed": a 2xx status survives but its schema/content
 *   disappears — the consumer's parser for that status now has nothing to parse.
 * - Non-2xx responses (4xx/5xx) are not inspected at all in v1: their schemas are
 *   error-shape contracts we don't yet model consumer reliance on. A change
 *   confined to a non-2xx response therefore never reaches this table and
 *   classifies as docs_only/additive — a deliberate v1 scope limit, not an
 *   oversight (see the "removal confined to a 404 response" test).
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
  "response-enum-value-added",
  "response-status-removed",
  "response-media-type-removed",
  "operation-removed",
  "security-scheme-changed",
]);

/** Non-breaking by construction, but named so classification stays a lookup, not a guess. */
const NEVER_BREAKING_RULES = new Set<string>([
  "response-property-added-required",
  "response-property-type-changed",
  "response-enum-value-removed",
  "operation-deprecated",
]);

export function isBreakingRule(rule: string | undefined): boolean {
  if (rule === undefined) return false;
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
