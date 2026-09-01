export type Classification = "breaking" | "deprecation" | "additive" | "docs_only" | "unknown";
export type ChangeSourceKind = "changelog" | "docs" | "sitemap" | "openapi" | "github_release";
export type SpecChangeKind = "added_required" | "removed" | "renamed" | "type_change" | "enum_removed";

// `rule` is an additive field (Task 6 amendment): a stable kebab-case id naming the specific
// direction-aware check that produced this change (e.g. "request-property-removed",
// "response-property-added-required"). It does not rename or remove anything above.
// Optional per the amendment's own wording on the type contract; every change diff.ts
// actually emits always sets it — classify.ts treats a missing rule as non-breaking.
export interface OperationChange { field: string; from?: string; to?: string; kind: SpecChangeKind; rule?: string }
export interface ChangedOperation { method: string; path: string; changes: OperationChange[] }
export interface SpecDiff { addedPaths: string[]; removedPaths: string[]; changedOperations: ChangedOperation[] }

export interface ChangeEntity { type: "resource" | "endpoint" | "param" | "sdk_method" | "package"; name: string }

export interface VendorChange {
  id: string;
  vendor_id: string;
  source: ChangeSourceKind;
  title: string;
  summary: string;
  api_version?: string;
  classification: Classification;
  breaking_confidence: number;
  entities: ChangeEntity[];
  source_urls: string[];
  spec_diff?: SpecDiff;
  raw_excerpt: string;          // max 20_000 chars, truncate on construction
  context_change_id?: string;
  fingerprint: string;
  created_at: string;           // ISO 8601
}

export type Ecosystem = "npm" | "pypi" | "gomod" | "rubygems";
export interface DetectedIntegration {
  vendor_id: string | null;
  ecosystem: Ecosystem;
  package_name: string;
  version?: string;
  evidence: string;             // e.g. "package.json:dependencies"
  confidence: number;           // 0-1
}

export interface Vendor {
  id: string;
  display_name: string;
  kind: "pack" | "generic";
  homepage?: string;
  docs_url?: string;
  changelog_url?: string;
  openapi_url?: string;
  github_repo?: string;         // "owner/name"
  sdk_packages: { ecosystem: Ecosystem; name: string }[];
}

export interface WatchTarget {
  type: "page" | "openapi" | "github_release";
  url?: string;                 // page + openapi
  repo?: string;                // github_release, "owner/name"
  detection?: "exact" | "semantic";
  instructions?: string;        // page semantic
}
export interface Watch { vendor_id: string; targets: WatchTarget[]; status: "active" | "paused" }

export interface SourceState {
  hash?: string;                // sha256 of last-seen spec body
  snapshot?: string;            // last-seen body (openapi) — stored by StateStore, not inline in config
  lastReleaseTag?: string;
  monitorId?: string;           // context.dev
  lastContextChangeId?: string;
  error?: string;
  updated_at: string;
}

export interface ImpactFileHit { path: string; lines: number[]; reason: string }
export type NotPatchableReason = "no_hits" | "unsupported_language" | "generated_client" | "low_confidence";
export interface ImpactReport {
  project_id: string;
  change_id: string;
  files: ImpactFileHit[];
  languages: string[];
  impact_score: number;
  patchable: boolean;
  reason_if_not?: NotPatchableReason;
}

export interface FileEdit { path: string; newContent: string }
export interface HealResult { edits: FileEdit[]; whatChanged: string[]; hasTodos: boolean }

export interface PrInput {
  vendorId: string; fingerprint: string;
  branch: string; title: string; body: string;
  edits: FileEdit[]; labels: string[]; draft: true;
}
export interface IssueInput { title: string; body: string; labels: string[] }

export interface PollResult { state: SourceState; changes: VendorChange[]; skipped?: string }
export interface ChangeSource {
  kind: "openapi" | "github_release" | "page";
  poll(target: WatchTarget, vendor: Vendor, prev: SourceState | null): Promise<PollResult>;
}
export interface RepoAccess {
  listFiles(): Promise<string[]>;        // repo-relative paths, skip-dirs already excluded
  read(path: string): Promise<string>;
}
export interface Publisher {
  openDraftPr(input: PrInput): Promise<{ url: string }>;
  updateDraftPr(branch: string, input: PrInput): Promise<{ url: string }>;
  findOpenAutoshimPr(vendorId: string): Promise<{ branch: string; url: string } | null>;
  openIssue(input: IssueInput): Promise<{ url: string }>;
}
