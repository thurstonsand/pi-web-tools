export type CappedResult<T> = {
  items: T[];
  truncated: boolean;
};

export async function listWithCap<T>(
  limit: number,
  fetchPage: (page: number, perPage: number) => Promise<T[]>,
): Promise<CappedResult<T>> {
  const items: T[] = [];
  let page = 1;
  while (items.length <= limit) {
    const perPage = Math.min(100, limit + 1 - items.length);
    const pageItems = await fetchPage(page, perPage);
    items.push(...pageItems);
    if (pageItems.length < perPage) break;
    page += 1;
  }
  const truncated = items.length > limit;
  return {
    items: items.slice(0, limit),
    truncated,
  };
}
