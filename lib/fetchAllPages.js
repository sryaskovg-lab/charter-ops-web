// Supabase/PostgREST silently caps any single response (1000 rows by default), so a plain
// select("*") on a big table just drops the rest with no error. This pages through with
// .range() until a page comes back empty (rather than "shorter than 1000", so it stays correct
// even if the project's max-rows setting is lower than the page size we ask for).
//
// makeQuery must return a FRESH query builder each call (builders are single-use), and should
// include a stable total order -- add .order("id") as a tiebreaker -- or rows that share the
// same sort value can be skipped or repeated across page boundaries.
export async function fetchAllPages(makeQuery, pageSize = 1000, maxRows = 200000) {
  const rows = [];
  for (let from = 0; from < maxRows; ) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    if (!data || data.length === 0) break;
    rows.push(...data);
    from += data.length;
  }
  return { data: rows, error: null };
}
