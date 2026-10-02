// Supabase/PostgREST silently caps a single response (default 1000 rows).
// This helper reads every page so catalog-style lists are never truncated.
// The first page is requested alone (small tables cost exactly one request);
// when it is full, the remaining pages are fetched in parallel batches.
export const TBILISI_TZ = "Asia/Tbilisi";

export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
  pageSize = 1000,
  maxRows = 50000,
  concurrency = 4,
): Promise<{ data: T[]; error: unknown }> {
  const rows: T[] = [];
  const first = await page(0, pageSize - 1);
  if (first.error) return { data: [], error: first.error };
  const firstChunk = (Array.isArray(first.data) ? first.data : []) as T[];
  rows.push(...firstChunk);
  if (firstChunk.length < pageSize) return { data: rows, error: null };

  for (let from = pageSize; from < maxRows; from += concurrency * pageSize) {
    const starts: number[] = [];
    for (let i = 0; i < concurrency && from + i * pageSize < maxRows; i++) {
      starts.push(from + i * pageSize);
    }
    const results = await Promise.all(starts.map((start) => page(start, start + pageSize - 1)));
    for (const { data, error } of results) {
      if (error) return { data: [], error };
      const chunk = (Array.isArray(data) ? data : []) as T[];
      rows.push(...chunk);
      if (chunk.length < pageSize) return { data: rows, error: null };
    }
  }
  return { data: rows, error: null };
}
