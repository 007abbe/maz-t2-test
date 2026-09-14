import { supabase } from '../lib/supabase.js'
import { getUser } from '../lib/auth.js'
import { fromRow, toRow, stampNow, uid } from './mapping.js'
import { listAccounts } from './accounts.js'
import { backtestAccountIds } from '../domain/account-vocab.js'
import { isRealTrade } from '../domain/veto-vocab.js'

/**
 * Cloud-first: Supabase is the only store. There is no localStorage mirror and
 * no merge step, because nothing keeps a local copy to reconcile. Writes still
 * stamp `updated_at` — it is the last-write-wins key, and a journal open in two
 * tabs is enough to need it.
 */

/**
 * Columns for the list view. Excludes `image` and `hindsight` — those are
 * fetched per-trade on demand, not for every row in the list.
 *
 * `thesis` is the one heavy field that has to travel with the list: the
 * journal's search box filters on it client-side, over the trades already
 * loaded. Fetching it per-row on keystroke would be a query per character.
 *
 * `custom` travels too. It is where a buyer's own vocabulary lives, so leaving
 * it out would mean the list could show a trade's strategy but not the setup
 * beside it — and every badge and filter over a user-defined field would need a
 * second query. It is small: text answers, not screenshots.
 */
const LIST_COLUMNS = `
  id, num, date, direction, status, pnl, risk, thesis, strategy,
  account_id, kind, custom, archived, updated_at
`

/**
 * Rows per request, and the ceiling on how many requests one read will make.
 *
 * Supabase caps a single response server-side (1000 by default), so a journal
 * bigger than one page has to be fetched in several. `listTrades` walks pages
 * until the table runs out — the previous single `.limit(500)` silently dropped
 * the oldest trades once a journal passed 500, and every tile and breakdown
 * then described a slice while claiming to describe the book.
 *
 * MAX_PAGES is a stop, not a limit: hitting it is reported to the caller as
 * `truncated`, so the journal can say so on screen. A number that is quietly
 * partial is the one thing this file must never produce.
 */
export const PAGE_SIZE = 1000
export const MAX_PAGES = 20

/** Beyond this many *active* trades, the journal offers to archive. */
export const ARCHIVE_THRESHOLD = 500

/** How many stay in the working list when an archive runs. */
export const ARCHIVE_KEEP = 100

/**
 * Every row matching `narrow`, fetched a page at a time.
 *
 * RLS on the `trades` table scopes rows to the signed-in user, so no query here
 * filters on user_id — the policy is the filter.
 *
 * `date` is a text column, so the ordering is lexicographic. That matches
 * chronological order only while dates stay in `YYYY-MM-DDTHH:mm` form. `id` is
 * the tie-break: two trades logged in the same minute would otherwise be free
 * to swap places between pages, which duplicates one and loses the other.
 */
async function fetchAll(columns, narrow = (q) => q) {
  const rows = []

  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE
    const { data, error } = await narrow(
      supabase
        .from('trades')
        .select(columns)
        .order('date', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + PAGE_SIZE - 1)
    )

    if (error) throw error
    rows.push(...(data ?? []))
    if ((data?.length ?? 0) < PAGE_SIZE) return { rows, truncated: false }
  }

  return { rows, truncated: true }
}

/**
 * Trades for the journal list.
 *
 * @param {{archived?: 'active'|'archived'|'all'}} [options] which side of the
 *   archive to read. 'active' is the default because that is the working list;
 *   every *aggregate* in the app asks for 'all', so no statistic changes meaning
 *   when a trade is archived.
 * @returns {Promise<{trades: object[], truncated: boolean}>}
 */
export async function listTrades({ archived = 'active' } = {}) {
  const narrow =
    archived === 'all' ? (q) => q : (q) => q.eq('archived', archived === 'archived')

  const { rows, truncated } = await fetchAll(LIST_COLUMNS, narrow)
  return { trades: rows, truncated }
}

/** How many trades sit on each side of the archive. Counted in SQL, not fetched. */
export async function countTrades() {
  const count = async (value) => {
    const { count: n, error } = await supabase
      .from('trades')
      .select('id', { count: 'exact', head: true })
      .eq('archived', value)

    if (error) throw error
    return n ?? 0
  }

  const [active, archived] = await Promise.all([count(false), count(true)])
  return { active, archived, total: active + archived }
}

/**
 * Moves every active trade except the newest `keep` into the archive.
 *
 * Ids are collected client-side and updated in one statement rather than with a
 * "not in the newest N" subquery, because PostgREST has no way to express that
 * and a raw SQL function would put a migration in a buyer's install path.
 *
 * `updated_at` is stamped, because archiving *is* an edit: a second tab holding
 * the old copy must not win a last-write-wins merge and quietly unarchive them.
 *
 * @returns {Promise<number>} how many were archived
 */
export async function archiveOldTrades({ keep = ARCHIVE_KEEP } = {}) {
  // `date desc` matches the list ordering, so "the newest `keep`" means the same
  // thing here as the rows the trader can see at the top of their journal.
  const { rows } = await fetchAll('id', (q) => q.eq('archived', false))
  const ids = rows.slice(keep).map((r) => r.id)
  if (!ids.length) return 0

  // Chunked: a URL carrying several thousand ids is refused by the gateway long
  // before Postgres would object.
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await supabase
      .from('trades')
      .update({ archived: true, updated_at: Date.now() })
      .in('id', ids.slice(i, i + 200))

    if (error) throw error
  }

  return ids.length
}

/** Puts one trade back in the working list. The inverse of an archive run. */
export async function restoreTrade(id) {
  const { error } = await supabase
    .from('trades')
    .update({ archived: false, updated_at: Date.now() })
    .eq('id', id)

  if (error) throw error
}

/**
 * Every column DOM's analysis reads — everything but `image`, which holds
 * base64 screenshots and would dominate the response for a large selection.
 *
 * This is the whole table minus one column, and that is the point of the
 * sixteen-column schema: there is no list of analysis fields to keep in sync
 * with the form, because the fields a buyer invents arrive inside `custom`.
 */
const ANALYSIS_COLUMNS = `
  id, num, date, direction, status, pnl, risk, thesis, hindsight,
  strategy, custom, account_id, kind, updated_at
`

/**
 * Trades for DOM, mapped through `fromRow`.
 *
 * The mapping is not optional: Postgres returns numerics as strings, and the
 * statistics module does arithmetic on `pnl` and `risk`. Unmapped rows would
 * produce quietly wrong numbers rather than an error.
 */
export async function listTradesForAnalysis() {
  // Accounts come along because DOM analyses *executed* trades: a backtest
  // account's fills were never real, and telling the model that a simulated run
  // is your live edge is worse than telling it nothing. Handful of rows, and it
  // rides alongside the trade query rather than after it.
  //
  // Archived trades are included: DOM reasons about a book, and a report that
  // silently stopped covering last quarter would be exactly the confident
  // half-answer the two-layer design exists to prevent. The trader narrows the
  // selection themselves in the picker.
  const [{ rows }, accounts] = await Promise.all([
    fetchAll(ANALYSIS_COLUMNS),
    listAccounts().catch(() => []),
  ])

  const backtest = backtestAccountIds(accounts)
  return rows
    .map(fromRow)
    .filter((t) => isRealTrade(t) && !backtest.has(t.account_id))
}

/** One full trade, including the heavy image/thesis/hindsight fields. */
export async function getTrade(id) {
  const { data, error } = await supabase
    .from('trades')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) throw error
  return data ? fromRow(data) : null
}

/**
 * Creates or updates one trade. Single-row upsert, so a save costs one request
 * and re-sends only this trade's screenshot rather than the whole journal's.
 *
 * Returns the saved trade as stored.
 */
export async function upsertTrade(trade) {
  const user = await getUser()
  if (!user) throw new Error('Not signed in')

  const row = toRow(stampNow({ ...trade, id: trade.id || uid() }), user.id)

  const { data, error } = await supabase
    .from('trades')
    .upsert(row, { onConflict: 'id' })
    .select()
    .single()

  if (error) throw error
  return fromRow(data)
}

export async function deleteTrade(id) {
  const { error } = await supabase.from('trades').delete().eq('id', id)
  if (error) throw error
}

/**
 * Next display number. Derived from the stored maximum rather than a count
 * (`trades.length + 1`), which cloud-first has no equivalent of, so it comes
 * from the current maximum instead. `num` is a display counter, not a key —
 * concurrent creates can collide, and that is acceptable.
 */
export async function nextTradeNum() {
  const { data, error } = await supabase
    .from('trades')
    .select('num')
    .order('num', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return (data?.num ?? 0) + 1
}
