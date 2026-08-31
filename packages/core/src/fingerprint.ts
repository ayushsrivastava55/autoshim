import { createHash } from "node:crypto";
import type { Classification, ChangeEntity } from "./types.js";

export function fingerprint(vendorId: string, entities: ChangeEntity[], classification: Classification, title: string): string {
  const names = entities.map((e) => e.name).sort().join(",");
  const norm = title.toLowerCase().replace(/\s+/g, " ").trim();
  const h = createHash("sha256").update(`${vendorId}|${names}|${classification}|${norm}`).digest("hex");
  return `sha256:${h}`;
}
export function fp8(fingerprintStr: string): string {
  return fingerprintStr.replace(/^sha256:/, "").slice(0, 8);
}
