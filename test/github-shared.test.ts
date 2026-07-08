import { describe, expect, it } from "vitest";
import { truncateUtf8Bytes } from "../extensions/web-tools/fetchers/github/shared.ts";

describe("truncateUtf8Bytes", () => {
  it("backs up to a code point boundary without adding marker text", () => {
    const truncated = truncateUtf8Bytes("ab💥cd", 4);

    expect(truncated).toBe("ab");
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(4);
  });

  it("leaves already-small strings unchanged", () => {
    expect(truncateUtf8Bytes("abc", 3)).toBe("abc");
  });
});
