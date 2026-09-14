/**
 * Deterministic trade statistics — DOM's Layer 1.
 *
 * Every number DOM reports is computed here. The model interprets these
 * figures and never calculates its own: that separation is the whole point of
 * the two-layer design, so this module owns arithmetic and owns it alone.
 *
 * Nothing here names a field the trader did not define. The only dimensions
 * this module knows by name are the ones that are columns — strategy, money,
 * sequence — and every other breakdown comes out of `custom`, discovered from
 * the trades themselves. That is what lets a buyer's own vocabulary produce the
 * same analysis the original hardcoded one did.
 *
 * Pure and agent-agnostic: no DOM, no fetch, no clock. Trades must already be
 * mapped through `fromRow` — Postgres returns numerics as strings, and string
 * arithmetic here would be silently wrong rather than loud.
 */

import { findField, isMultiValue } from './config.js'

/** Below this, a group is not reportable — only listable as insufficient. */
export const MIN_SAMPLE = 5

/** Up to this, a group is reportable but only as a provisional signal. */
export const EARLY_SIGNAL_MAX = 9

const round = (value, places) => Number(value.toFixed(places))

/**
 * Realised R. Null when risk is missing or zero — an R-multiple against no
 * declared risk is meaningless, and dividing by it would poison every average
 * downstream.
 */
export function rMultiple(trade) {
  return trade.risk > 0 ? trade.pnl / trade.risk : null
}

/**
 * Aggregate one group of trades.
 *
 * `insufficient` and `earlySignal` are carried as data rather than left for the
 * model to derive: DOM's sample-size rule is then something it reads, not
 * arithmetic it performs, and the threshold lives in one place instead of being
 * restated in prompt prose.
 */
export function aggregate(list) {
  const n = list.length
  const rs = list.map(rMultiple).filter((r) => r != null)
  const wins = list.filter((t) => t.pnl > 0).length
  const losses = list.filter((t) => t.pnl < 0).length
  const totalR = rs.reduce((sum, r) => sum + r, 0)

  return {
    n,
    wins,
    losses,
    be: n - wins - losses,
    winRate: n ? round((wins / n) * 100, 1) : null,
    avgR: rs.length ? round(totalR / rs.length, 2) : null,
    totalR: rs.length ? round(totalR, 2) : null,
    // avgR is averaged over rSample, not n — trades with no declared risk have
    // no R. Without this the model would read avgR as covering the whole group.
    rSample: rs.length,
    insufficient: n < MIN_SAMPLE,
    earlySignal: n >= MIN_SAMPLE && n <= EARLY_SIGNAL_MAX,
  }
}

/** Groups by `key(trade)`, with null/undefined collected under `untagged`. */
export function groupBy(list, key) {
  const groups = {}
  for (const trade of list) {
    const k = key(trade) ?? 'untagged'
    ;(groups[k] ??= []).push(trade)
  }

  return Object.fromEntries(
    Object.entries(groups).map(([k, trades]) => [k, aggregate(trades)])
  )
}

/**
 * groupBy for array-valued fields like a tag list.
 *
 * A trade carrying two tags is counted in both buckets, so unlike groupBy
 * these group sizes sum to MORE than the number of trades. Anything presenting
 * them — DOM included — must not add them up and call the total a trade count.
 * A trade with no values lands in `untagged`.
 */
export function groupByEach(list, keys) {
  const groups = {}
  for (const trade of list) {
    const values = keys(trade)
    // Array-checked, not just truthy: a stray scalar would otherwise iterate
    // its own characters and invent a bucket per letter.
    for (const k of Array.isArray(values) && values.length ? values : ['untagged']) {
      ;(groups[k] ??= []).push(trade)
    }
  }

  return Object.fromEntries(
    Object.entries(groups).map(([k, trades]) => [k, aggregate(trades)])
  )
}

const toArray = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v])

/**
 * The bucket a numeric answer falls in, or null when the field defines none.
 *
 * Buckets are why a number field can be grouped at all. Without them an entry
 * price produces one bucket per distinct price — a table as long as the journal
 * with an n of 1 in every row, which is noise wearing the costume of a finding.
 * So an unbucketed number is recorded and reported per-trade, never grouped.
 */
export function bucketOf(field, value) {
  const buckets = field?.buckets ?? []
  if (!buckets.length) return null

  const n = Number(value)
  if (!Number.isFinite(n)) return null

  for (const b of buckets) {
    if (b.max === null || b.max === undefined || n <= b.max) return b.label
  }
  // Past every bound and the last bucket was closed: the field's buckets do not
  // cover this value, and inventing a home for it would misreport the group.
  return null
}

/**
 * Every user-defined field, grouped by its own values.
 *
 * Keyed by the generated field id from `config.custom_fields`, never by the
 * field's label — ARCHITECTURE.md, rule 2. The caller resolves ids to labels for
 * display, so renaming a field renames a heading and moves no trade between
 * buckets.
 *
 * Fields are discovered from the trades themselves rather than from config, so
 * a field the trader has since deleted still reports the history it collected
 * instead of vanishing from the stats with its trades still counted in the
 * totals. Config is consulted only for *how* to group — which is why it is
 * optional here and its absence degrades to grouping by raw value.
 */
export function groupByCustom(list, config = null) {
  const ids = new Set()
  for (const trade of list) {
    for (const id of Object.keys(trade.custom ?? {})) ids.add(id)
  }

  const out = {}
  for (const id of ids) {
    const field = config ? findField(config, id) : null

    if (field?.type === 'number') {
      // Unbucketed numbers are skipped rather than grouped — see bucketOf.
      if (!field.buckets?.length) continue
      out[id] = groupBy(
        list.filter((t) => t.custom?.[id] != null),
        (t) => bucketOf(field, t.custom?.[id])
      )
      continue
    }

    // A field is array-valued when config says so, or — with no config, or for
    // a field since deleted — when any trade answers it with several values.
    // Deciding per field rather than per trade keeps one field's buckets from
    // being built two different ways.
    const multi = field
      ? isMultiValue(field)
      : list.some((t) => Array.isArray(t.custom?.[id]))

    out[id] = multi
      ? groupByEach(list, (t) => toArray(t.custom?.[id]))
      : groupBy(list, (t) => t.custom?.[id])
  }

  return out
}

/**
 * Trades taken after two or more consecutive losses — the tilt sequence.
 * Chronological, so a mis-sorted input would silently measure the wrong thing.
 *
 * This one is hardcoded and stays hardcoded: it is a property of the *sequence*
 * of trades, not of anything the trader tagged, so there is no custom field a
 * buyer could define that would produce it.
 */
function afterTwoLosses(chronological) {
  return chronological.filter(
    (_, i) =>
      i >= 2 && chronological[i - 1].pnl < 0 && chronological[i - 2].pnl < 0
  )
}

/**
 * The full statistics object DOM reasons over.
 *
 * @param {Array<object>} trades mapped trades (see `fromRow`)
 * @param {object|null} config the trader's config, used only to decide how each
 *   custom field groups. Omitting it is safe: fields still group by raw value.
 */
export function computeTradeStats(trades, config = null) {
  // `date` is 'YYYY-MM-DDTHH:mm' text, so lexicographic order is chronological
  // order — no Date parsing, no timezone in the comparison.
  const chronological = [...trades].sort((a, b) =>
    (a.date ?? '').localeCompare(b.date ?? '')
  )

  return {
    overall: aggregate(chronological),
    byStrategy: groupBy(chronological, (t) => t.strategy),
    byDirection: groupBy(chronological, (t) => t.direction),
    byStatus: groupBy(chronological, (t) => t.status),
    // Every user-defined field, grouped by its generated id (§4.2). Labels are
    // resolved for display from config, never stored on the trade, so a renamed
    // field keeps every historical row in the same bucket.
    byCustom: groupByCustom(chronological, config),
    afterTwoLosses: aggregate(afterTwoLosses(chronological)),
    untaggedCount: chronological.filter((t) => !t.strategy).length,
    thresholds: { minSample: MIN_SAMPLE, earlySignalMax: EARLY_SIGNAL_MAX },
  }
}
