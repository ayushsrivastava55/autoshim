import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { Vendor, WatchTarget, Ecosystem } from "./types.js";

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
  id: z.string().min(1),
  display_name: z.string().min(1),
  homepage: z.string().optional(),
  docs_url: z.string().optional(),
  changelog_url: z.string().optional(),
  openapi_url: z.string().optional(),
  github_repo: z.string().optional(),
  packages: z.record(z.array(z.string())).optional().default({}),
  import_patterns: z.record(z.array(z.string())).optional().default({}),
  watch: z.array(z.object({
    type: z.enum(["page", "openapi", "github_release"]),
    url: z.string().optional(),
    repo: z.string().optional(),
    detection: z.enum(["exact", "semantic"]).optional(),
    instructions: z.string().optional(),
  })).default([]),
  heal: z.object({
    languages: z.array(z.string()),
    notes: z.string().optional(),
  }).optional(),
});

export function parsePack(yamlText: string): Pack {
  const data = parseYaml(yamlText);
  return PackSchema.parse(data) as Pack;
}

export interface PackRegistry {
  byId(id: string): Pack | undefined;
  byPackage(ecosystem: Ecosystem, name: string): Pack | undefined;
  all(): Pack[];
  vendorFor(pack: Pack): Vendor;
}

export function loadPacks(yamlTexts: string[]): PackRegistry {
  const packs: Pack[] = [];
  const byIdMap = new Map<string, Pack>();
  const byPackageMap = new Map<string, Pack>();

  // Parse all packs first
  for (const yamlText of yamlTexts) {
    const pack = parsePack(yamlText);
    packs.push(pack);
    byIdMap.set(pack.id, pack);
  }

  // Build package mapping and check for duplicates
  for (const pack of packs) {
    for (const [ecosystem, names] of Object.entries(pack.packages)) {
      for (const name of names) {
        const key = `${ecosystem}:${name}`;
        if (byPackageMap.has(key)) {
          const existing = byPackageMap.get(key)!;
          throw new Error(`duplicate package mapping: ${key} claimed by ${existing.id} and ${pack.id}`);
        }
        byPackageMap.set(key, pack);
      }
    }
  }

  return {
    byId(id: string): Pack | undefined {
      return byIdMap.get(id);
    },
    byPackage(ecosystem: Ecosystem, name: string): Pack | undefined {
      const key = `${ecosystem}:${name}`;
      return byPackageMap.get(key);
    },
    all(): Pack[] {
      return packs;
    },
    vendorFor(pack: Pack): Vendor {
      // Flatten packages into sdk_packages
      const sdk_packages: { ecosystem: Ecosystem; name: string }[] = [];
      for (const [ecosystem, names] of Object.entries(pack.packages)) {
        for (const name of names) {
          sdk_packages.push({
            ecosystem: ecosystem as Ecosystem,
            name,
          });
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
