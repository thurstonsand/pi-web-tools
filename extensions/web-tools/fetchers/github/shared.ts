export type OctokitRequestOptions = { request?: { signal?: AbortSignal } };

export function requestOptions(signal: AbortSignal | undefined): OctokitRequestOptions {
  return signal ? { request: { signal } } : {};
}

export function truncateUtf8Bytes(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return value;

  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end >= 0; end -= 1) {
    try {
      return decoder.decode(buffer.subarray(0, end));
    } catch {
      // Drop the partial code point and try again.
    }
  }
  return "";
}

export function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
