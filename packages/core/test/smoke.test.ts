import { describe, it, expect } from "vitest";
import { CORE_VERSION } from "../src/index.js";

describe("workspace", () => {
  it("core is importable", () => {
    expect(CORE_VERSION).toBe("0.1.0");
  });
});
