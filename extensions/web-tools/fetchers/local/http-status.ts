export function throwForHttpError(status: number, url: string): void {
  if (status >= 400) throw new Error(`HTTP ${status} while fetching ${url}`);
}
