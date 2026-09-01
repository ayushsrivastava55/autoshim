import { describe, it, expect } from "vitest";
import { fingerprint, fp8 } from "../src/fingerprint.js";

describe("fingerprint", () => {
  const ents = [{ type: "param" as const, name: "charges.source" }, { type: "endpoint" as const, name: "GET /v1/charges" }];
  it("is stable across entity order and title whitespace/case", () => {
    const a = fingerprint("stripe", ents, "breaking", "Removed  Charges Source");
    const b = fingerprint("stripe", [...ents].reverse(), "breaking", "removed charges source");
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it("differs by vendor and classification", () => {
    const a = fingerprint("stripe", ents, "breaking", "t");
    expect(fingerprint("shopify", ents, "breaking", "t")).not.toBe(a);
    expect(fingerprint("stripe", ents, "deprecation", "t")).not.toBe(a);
  });
  it("fp8 gives first 8 hex chars", () => {
    expect(fp8("sha256:abcdef0123456789")).toBe("abcdef01");
  });
});
