import { parse as parseToml } from "smol-toml";
import type { DetectedIntegration, Ecosystem, RepoAccess } from "./types.js";
import type { PackRegistry } from "./packs.js";

export function parseManifest(filename: string, content: string): DetectedIntegration[] {
  if (!content || !content.trim()) {
    return [];
  }

  switch (filename) {
    case "package.json":
      return parsePackageJson(content);
    case "requirements.txt":
      return parseRequirementsTxt(content);
    case "pyproject.toml":
      return parsePyprojectToml(content);
    case "go.mod":
      return parseGoMod(content);
    case "Gemfile.lock":
      return parseGemfileLock(content);
    case "package-lock.json":
      return parsePackageLockJson(content);
    case "pnpm-lock.yaml":
      return parsePnpmLockYaml(content);
    case "yarn.lock":
      return parseYarnLock(content);
    case "poetry.lock":
      return parsePoetryLock(content);
    case "Pipfile.lock":
      return parsePipfileLock(content);
    default:
      return [];
  }
}

function parsePackageJson(content: string): DetectedIntegration[] {
  try {
    const pkg = JSON.parse(content);
    const deps = pkg.dependencies || {};
    const names = Object.keys(deps);
    return names.map((name) => ({
      vendor_id: null,
      ecosystem: "npm",
      package_name: name,
      evidence: "package.json:dependencies",
      confidence: 0.9,
    }));
  } catch {
    return [];
  }
}

function parseRequirementsTxt(content: string): DetectedIntegration[] {
  const lines = content.split("\n");
  const names: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comment lines
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    // Strip everything after semicolon (markers)
    const withoutMarkers = trimmed.split(";")[0].trim();

    // Strip extras syntax [...]
    const withoutExtras = withoutMarkers.replace(/\[.*?\]/g, "").trim();

    // Extract package name: split at first occurrence of version specifiers
    const match = withoutExtras.match(/^([a-zA-Z0-9._-]+)/);
    if (match) {
      names.push(match[1]);
    }
  }

  return names.map((name) => ({
    vendor_id: null,
    ecosystem: "pypi",
    package_name: name,
    evidence: "requirements.txt",
    confidence: 0.9,
  }));
}

function parsePyprojectToml(content: string): DetectedIntegration[] {
  try {
    const parsed = parseToml(content);
    const names: string[] = [];

    // Read project.dependencies
    const project = parsed.project as Record<string, unknown> | undefined;
    if (project && Array.isArray(project.dependencies)) {
      for (const dep of project.dependencies) {
        if (typeof dep === "string") {
          // Extract package name: split at first version specifier or whitespace
          const name = dep.split(/[\s<>=!~\[]/)[0].trim();
          if (name) {
            names.push(name);
          }
        }
      }
    }

    // Read tool.poetry.dependencies
    const tool = parsed.tool as Record<string, unknown> | undefined;
    if (tool) {
      const poetry = tool.poetry as Record<string, unknown> | undefined;
      if (poetry) {
        const dependencies = poetry.dependencies as Record<string, unknown> | undefined;
        if (dependencies) {
          for (const key of Object.keys(dependencies)) {
            // Skip python itself
            if (key.toLowerCase() !== "python") {
              names.push(key);
            }
          }
        }
      }
    }

    return names.map((name) => ({
      vendor_id: null,
      ecosystem: "pypi",
      package_name: name,
      evidence: "pyproject.toml",
      confidence: 0.9,
    }));
  } catch {
    return [];
  }
}

function parseGoMod(content: string): DetectedIntegration[] {
  const lines = content.split("\n");
  const names: string[] = [];
  let inRequire = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect require block
    if (trimmed === "require (") {
      inRequire = true;
      continue;
    }

    if (inRequire) {
      if (trimmed === ")") {
        inRequire = false;
        continue;
      }

      // Extract module name (first token)
      const tokens = trimmed.split(/\s+/);
      if (tokens[0]) {
        names.push(tokens[0]);
      }
    } else if (trimmed.startsWith("require ")) {
      // Single-line require
      const parts = trimmed.slice(8).trim().split(/\s+/);
      if (parts[0]) {
        names.push(parts[0]);
      }
    }
  }

  return names.map((name) => ({
    vendor_id: null,
    ecosystem: "gomod",
    package_name: name,
    evidence: "go.mod",
    confidence: 0.9,
  }));
}

function parseGemfileLock(content: string): DetectedIntegration[] {
  const lines = content.split("\n");
  const names: string[] = [];
  let inSpecs = false;

  for (const line of lines) {
    if (line.trim() === "specs:") {
      inSpecs = true;
      continue;
    }

    if (inSpecs) {
      // Stop at next section (non-indented line)
      if (line && !line.startsWith("  ") && !line.startsWith("\t")) {
        inSpecs = false;
        continue;
      }

      // Match gem name pattern: /^    (\S+) \(/
      const match = line.match(/^    (\S+) \(/);
      if (match) {
        names.push(match[1]);
      }
    }
  }

  return names.map((name) => ({
    vendor_id: null,
    ecosystem: "rubygems",
    package_name: name,
    evidence: "Gemfile.lock",
    confidence: 0.6,
  }));
}

function parsePackageLockJson(content: string): DetectedIntegration[] {
  try {
    const lockfile = JSON.parse(content);
    const packages = lockfile.packages || {};
    const names: string[] = [];

    // Extract package names from node_modules paths
    for (const key of Object.keys(packages)) {
      // Key format: "node_modules/<name>" or "node_modules/<scope>/<name>"
      if (key.startsWith("node_modules/")) {
        const pkgPath = key.slice("node_modules/".length);
        // Get the actual package name (last component of path)
        const name = pkgPath.split("/").pop();
        if (name) {
          names.push(name);
        }
      }
    }

    return names.map((name) => ({
      vendor_id: null,
      ecosystem: "npm",
      package_name: name,
      evidence: "package-lock.json",
      confidence: 0.6,
    }));
  } catch {
    return [];
  }
}

function parsePnpmLockYaml(content: string): DetectedIntegration[] {
  // Simple YAML parser for pnpm-lock.yaml
  // We're only extracting keys from top-level dependencies and devDependencies
  const names: string[] = [];
  const lines = content.split("\n");

  let inDependencies = false;
  let inDevDependencies = false;

  for (const line of lines) {
    // Check for dependencies section
    if (line.startsWith("dependencies:")) {
      inDependencies = true;
      inDevDependencies = false;
      continue;
    }
    if (line.startsWith("devDependencies:")) {
      inDevDependencies = true;
      inDependencies = false;
      continue;
    }

    // Stop sections on non-indented lines that start with letters
    if (line && !line.startsWith(" ") && line.match(/^[a-zA-Z]/)) {
      inDependencies = false;
      inDevDependencies = false;
      continue;
    }

    // Parse entries: "  package_name:" format
    if ((inDependencies || inDevDependencies) && line.startsWith("  ")) {
      const match = line.match(/^  ([^:]+):/);
      if (match) {
        const pkgName = match[1].trim();
        if (pkgName && !pkgName.startsWith("#")) {
          names.push(pkgName);
        }
      }
    }
  }

  return names.map((name) => ({
    vendor_id: null,
    ecosystem: "npm",
    package_name: name,
    evidence: "pnpm-lock.yaml",
    confidence: 0.6,
  }));
}

function parseYarnLock(content: string): DetectedIntegration[] {
  // Yarn lock files use a key-based format
  // We extract keys that represent package names
  const names: string[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    // Skip empty lines and metadata
    if (!line.trim() || line.startsWith("#") || line.startsWith(" ")) {
      continue;
    }

    // Parse entries like "package@version:"
    const match = line.match(/^([^@]+)@/);
    if (match) {
      const name = match[1].trim();
      // Avoid duplicates
      if (!names.includes(name)) {
        names.push(name);
      }
    }
  }

  return names.map((name) => ({
    vendor_id: null,
    ecosystem: "npm",
    package_name: name,
    evidence: "yarn.lock",
    confidence: 0.6,
  }));
}

function parsePoetryLock(content: string): DetectedIntegration[] {
  // Poetry lock files have [[package]] sections
  const names: string[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    // Look for [[package]] headers
    if (line.startsWith("[[package]]")) {
      // Next meaningful line should be name = "..."
      for (let i = lines.indexOf(line) + 1; i < lines.length; i++) {
        const nextLine = lines[i].trim();
        if (nextLine.startsWith("name = ")) {
          const match = nextLine.match(/name = "([^"]+)"/);
          if (match) {
            names.push(match[1]);
          }
          break;
        }
        if (nextLine.startsWith("[[")) break; // Next section
      }
    }
  }

  return names.map((name) => ({
    vendor_id: null,
    ecosystem: "pypi",
    package_name: name,
    evidence: "poetry.lock",
    confidence: 0.6,
  }));
}

function parsePipfileLock(content: string): DetectedIntegration[] {
  try {
    const lock = JSON.parse(content);
    const names: string[] = [];

    // Pipfile.lock has "default" and "develop" sections
    for (const section of ["default", "develop"]) {
      const deps = lock[section] as Record<string, unknown> | undefined;
      if (deps) {
        for (const name of Object.keys(deps)) {
          if (!names.includes(name)) {
            names.push(name);
          }
        }
      }
    }

    return names.map((name) => ({
      vendor_id: null,
      ecosystem: "pypi",
      package_name: name,
      evidence: "Pipfile.lock",
      confidence: 0.6,
    }));
  } catch {
    return [];
  }
}

export async function discover(repo: RepoAccess, registry: PackRegistry): Promise<DetectedIntegration[]> {
  const files = await repo.listFiles();

  // Map of (ecosystem, package_name) to highest-confidence integration
  const seen = new Map<string, DetectedIntegration>();

  // Find and parse manifest files
  for (const file of files) {
    const basename = file.split("/").pop();
    if (!basename) continue;

    // Check if this is a manifest file we know how to parse
    const isManifest = [
      "package.json",
      "requirements.txt",
      "pyproject.toml",
      "go.mod",
      "Gemfile.lock",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "poetry.lock",
      "Pipfile.lock",
    ].includes(basename);

    if (!isManifest) continue;

    const content = await repo.read(file);
    const parsed = parseManifest(basename, content);

    for (const integration of parsed) {
      const key = `${integration.ecosystem}:${integration.package_name}`;
      const existing = seen.get(key);

      // Keep highest-confidence version
      if (!existing || integration.confidence > existing.confidence) {
        // Resolve vendor_id from registry
        const pack = registry.byPackage(integration.ecosystem, integration.package_name);
        seen.set(key, {
          ...integration,
          vendor_id: pack?.id || null,
        });
      }
    }
  }

  return Array.from(seen.values());
}

export function detectLanguages(files: string[]): string[] {
  const languages = new Set<string>();

  for (const file of files) {
    if (file.endsWith(".ts") || file.endsWith(".tsx")) {
      languages.add("typescript");
    }
    if (file.endsWith(".js") || file.endsWith(".jsx")) {
      languages.add("javascript");
    }
    if (file.endsWith(".py")) {
      languages.add("python");
    }
    if (file.endsWith("go.mod") || file.endsWith(".go")) {
      languages.add("go");
    }
    if (file.endsWith("Gemfile") || file.endsWith("Gemfile.lock") || file.endsWith(".rb")) {
      languages.add("ruby");
    }

    // Check for manifest files
    if (file.endsWith("package.json")) {
      languages.add("javascript");
    }
    if (file.endsWith("requirements.txt") || file.endsWith("pyproject.toml") || file.endsWith("Pipfile") || file.endsWith("Pipfile.lock")) {
      languages.add("python");
    }
    if (file.endsWith("go.mod")) {
      languages.add("go");
    }
    if (file.endsWith("Gemfile") || file.endsWith("Gemfile.lock")) {
      languages.add("ruby");
    }
  }

  return Array.from(languages);
}
