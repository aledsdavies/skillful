import { describe, expect, test } from "bun:test";
import { formatVersion } from "./version.ts";

describe("formatVersion", () => {
  test.each([
    ["0.1.0", null, null, "skillful 0.1.0"],
    ["0.1.0", null, "sha256-abc=", "skillful 0.1.0 (source sha256-abc=)"],
    ["0.1.0", "b150f6173175", "sha256-abc=", "skillful 0.1.0 (rev b150f6173175; source sha256-abc=)"],
  ] as const)("formats %s / %s / %s", (version, revision, sourceHash, printed) => {
    expect(formatVersion(version, revision, sourceHash)).toBe(printed);
  });
});
