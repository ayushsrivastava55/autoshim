import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";
import type { Vendor, WatchTarget, Ecosystem } from "./types.js";

export interface Pack {
  id: string;
  display_name: string;
  homepage?: string;
  docs_url?: string;
  changelog_url?: string;
  openapi_url?: string;
  github_repo?: string;
  packages: Partial<Record<Ecosystem, string[]>>;
  import_patterns: Record<string, string[]>;
  watch: WatchTarget[];
  heal?: { languages: string[]; notes?: string };
}

const PackSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  homepage: z.string().optional(),
  docs_url: z.string().optional(),
  changelog_url: z.string().optional(),
  openapi_url: z.string().optional(),
  github_repo: z.string().optional(),
  packages: z
    .record(z.enum(["npm", "pypi", "gomod", "rubygems"]), z.array(z.string()))
    .optional()
    .default({}) as any as z.ZodType<Partial<Record<Ecosystem, string[]>>>,
  import_patterns: z.record(z.array(z.string())),
  watch: z.array(
    z.object({
      type: z.enum(["page", "openapi", "github_release"]),
      url: z.string().optional(),
      repo: z.string().optional(),
      detection: z.enum(["exact", "semantic"]).optional(),
      instructions: z.string().optional(),
    })
  ),
  heal: z
    .object({
      languages: z.array(z.string()),
      notes: z.string().optional(),
    })
    .optional(),
}) as z.ZodType<Pack>;

export function parsePack(yamlText: string): Pack {
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    if (err instanceof YAMLParseError) {
      throw new Error(`Invalid YAML syntax: ${err.message}`);
    }
    throw err;
  }

  try {
    return PackSchema.parse(parsed);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ");
      throw new Error(`Pack validation failed: ${issues}`);
    }
    throw err;
  }
}

export interface PackRegistry {
  byId(id: string): Pack | undefined;
  byPackage(ecosystem: Ecosystem, name: string): Pack | undefined;
  all(): Pack[];
  vendorFor(pack: Pack): Vendor;
}

export function loadPacks(yamlTexts: string[]): PackRegistry {
  const packs: Pack[] = [];
  const idMap = new Map<string, Pack>();
  const pkgMap = new Map<string, Pack>();

  for (const yamlText of yamlTexts) {
    const pack = parsePack(yamlText);
    packs.push(pack);
    idMap.set(pack.id, pack);

    // Build package map and check for duplicates
    for (const [ecosystem, names] of Object.entries(pack.packages)) {
      for (const name of names) {
        const key = `${ecosystem}:${name}`;
        const existing = pkgMap.get(key);
        if (existing) {
          throw new Error(`duplicate package mapping: ${key} claimed by ${existing.id} and ${pack.id}`);
        }
        pkgMap.set(key, pack);
      }
    }
  }

  return {
    byId(id: string): Pack | undefined {
      return idMap.get(id);
    },
    byPackage(ecosystem: Ecosystem, name: string): Pack | undefined {
      return pkgMap.get(`${ecosystem}:${name}`);
    },
    all(): Pack[] {
      return packs;
    },
    vendorFor(pack: Pack): Vendor {
      const sdk_packages: Array<{ ecosystem: Ecosystem; name: string }> = [];
      for (const [ecosystem, names] of Object.entries(pack.packages) as Array<[Ecosystem, string[]]>) {
        for (const name of names) {
          sdk_packages.push({ ecosystem, name });
        }
      }

      return {
        id: pack.id,
        display_name: pack.display_name,
        kind: "pack",
        homepage: pack.homepage,
        docs_url: pack.docs_url,
        changelog_url: pack.changelog_url,
        openapi_url: pack.openapi_url,
        github_repo: pack.github_repo,
        sdk_packages,
      };
    },
  };
}
