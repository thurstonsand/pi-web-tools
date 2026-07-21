import { describe, expect, it } from "vitest";
import { throwForHttpError } from "../extensions/web-tools/fetchers/local/http-status.ts";

describe("throwForHttpError", () => {
  it.each([200, 204, 301, 307, 399])("accepts HTTP %i", (status) => {
    expect(() => throwForHttpError(status, "https://example.com/path")).not.toThrow();
  });

  it.each([400, 404, 429, 500, 503])("rejects HTTP %i", (status) => {
    expect(() => throwForHttpError(status, "https://example.com/path")).toThrow(
      `HTTP ${status} while fetching https://example.com/path`,
    );
  });
});
