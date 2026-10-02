// Supabase/PostgREST silently caps a single response (default 1000 rows).
// This helper reads every page so catalog-style lists are never truncated.
export const TBILISI_TZ = "Asia/Tbilisi";

export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  pageSize = 1000,
  maxRows = 50000,
): Promise<{ data: T[]; error: unknown }> {
  const rows: T[] = [];
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) return { data: [], error };
    const chunk = (Array.isArray(data) ? data : []) as T[];
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
  }
  return { data: rows, error: null };
}
