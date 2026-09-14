/**
 * Everything the Statistics view displays, computed from the trades the journal
 * already loads. Pure: no Supabase, no DOM, no new columns.
 *
 * A third stats module alongside `journal/stats.js` and `domain/trade-stats.js`
 * needs justifying. It exists because this one answers to a *page* rather than
 * a header strip or a model prompt: it returns grouped blocks (extremes,
 * averages, a cumulative curve, breakdowns) that neither of the others has a
 * use for. The definitions are pinned by tests, so this page and the header
 * strip always agree on the same numbers — see the notes on each block below.
 *
 * Adding a block means adding one key to the returned object and one renderer
 * in `index.js`; nothing else has to change.
 */

import { bucketOf } from '../domain/trade-stats.js'
import { fieldsFor, isMultiValue } from '../domain/config.js'
import { statusList } from '../domain/trade-vocab.js'

const num = (v) => Number(v ?? 0)
const sum = (rows) => rows.reduce((a, t) => a + num(t.pnl), 0)
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null)

/**
 * Winners and losers are counted across *all* trades, but breakeven only among
 * closed ones — so an Open trade sitting at exactly 0 is not counted as
 * breakeven. An open position has no outcome yet, and calling one breakeven
 * would put it in a bucket it can still leave.
 */
function totals(trades) {
  const wins = trades.filter((t) => num(t.pnl) > 0)
  const losses = trades.filter((t) => num(t.pnl) < 0)
  const breakeven = trades.filter((t) => num(t.pnl) === 0 && t.status !== 'Open')

  return {
    total: trades.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
  }
}

function extremes(trades) {
  const pnls = trades.map((t) => num(t.pnl))
  return {
    best: pnls.length ? Math.max(...pnls) : null,
    worst: pnls.length ? Math.min(...pnls) : null,
  }
}

/**
 * `avgR` is realised R — pnl ÷ risk — and it is the only R the product reports.
 *
 * The old schema also stored a planned reward-to-risk in its own column, which
 * meant this page and the journal header showed two different numbers both
 * labelled R. Planned R:R is now a user-defined field like any other: it can be
 * recorded, and it is not confused with what the trade actually returned.
 *
 * Trades with no declared risk have no R at all and are left out of the mean
 * rather than counted as zero, which would pull every average toward the middle.
 */
function averages(trades) {
  const winPnls = trades.map((t) => num(t.pnl)).filter((p) => p > 0)
  const lossPnls = trades.map((t) => num(t.pnl)).filter((p) => p < 0)
  const grossWin = winPnls.reduce((a, b) => a + b, 0)
  const grossLoss = Math.abs(lossPnls.reduce((a, b) => a + b, 0))

  return {
    avgWinner: mean(winPnls),
    avgLoser: mean(lossPnls),
    avgR: mean(
      trades.filter((t) => num(t.risk) > 0).map((t) => num(t.pnl) / num(t.risk))
    ),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
  }
}

/**
 * Running total in chronological order, oldest first — one point per trade.
 * `date` is text in `YYYY-MM-DDTHH:mm` form, so string order is time order.
 */
function curve(trades) {
  const chronological = [...trades].sort((a, b) =>
    String(a.date ?? '').localeCompare(String(b.date ?? ''))
  )

  let running = 0
  return chronological.map((t) => {
    running += num(t.pnl)
    return { num: t.num, pnl: num(t.pnl), cumulative: running }
  })
}

function group(trades, rows) {
  return rows.map(({ key, label }) => ({
    label,
    ...summarise(trades.filter((t) => t[key.field] === key.value)),
  }))
}

const DIRECTIONS = ['Long', 'Short']

/** One breakdown row: how many, how often it won, what it made. */
function summarise(members) {
  const wins = members.filter((t) => num(t.pnl) > 0).length
  return {
    count: members.length,
    winRate: members.length ? Math.round((wins / members.length) * 100) : null,
    pnl: sum(members),
  }
}

/**
 * The values a field was actually answered with, in the order config lists its
 * options, with anything else appended.
 *
 * Read from the data rather than from config alone, for the same reason
 * `statusesPresent` is: an option the trader removed last month still has
 * history, and dropping it here would leave those trades counted in the totals
 * but visible in no row.
 */
function valuesPresent(field, trades) {
  const present = new Set()
  for (const t of trades) {
    const v = t.custom?.[field.id]
    if (v === null || v === undefined || v === '') continue
    for (const one of Array.isArray(v) ? v : [v]) {
      const label = field.type === 'number' ? bucketOf(field, one) : String(one)
      if (label) present.add(label)
    }
  }

  const listed = field.type === 'number'
    ? (field.buckets ?? []).map((b) => b.label)
    : (field.options ?? [])

  const known = listed.filter((v) => present.has(v))
  const extra = [...present].filter((v) => !listed.includes(v)).sort()
  return [...known, ...extra]
}

/**
 * Every user-defined field, broken down by its own answers.
 *
 * This is what replaced the hardcoded breakdowns the original journal had. A
 * buyer defines "Setup" or "Session" or "Mood" and gets the same table the
 * built-in ones used to produce, keyed on the field id so renaming the field
 * renames the heading and moves no trade between rows (§4.2).
 *
 * A number field without buckets is skipped: one row per distinct price is a
 * table as long as the journal with an n of 1 in every row.
 *
 * Multi-value fields are marked, because their rows sum to more than the trade
 * count — a trade with two tags is in two rows — and a reader who adds the
 * column up must be told not to.
 */
function byField(trades, config) {
  if (!config) return []

  // Every field the trader has defined, whichever strategy it is scoped to:
  // this page looks across the whole journal, not at one trade's form.
  const fields = fieldsFor(config, null).concat(
    (config.custom_fields ?? []).filter((f) => f.strategy)
  )

  return fields
    .filter((f) => f.type !== 'number' || f.buckets?.length)
    .map((field) => {
      const matches = (t, value) => {
        const v = t.custom?.[field.id]
        if (v === null || v === undefined || v === '') return false
        const values = Array.isArray(v) ? v : [v]
        return field.type === 'number'
          ? values.some((one) => bucketOf(field, one) === value)
          : values.some((one) => String(one) === value)
      }

      return {
        id: field.id,
        label: field.label,
        multi: isMultiValue(field),
        rows: valuesPresent(field, trades).map((value) => ({
          label: value,
          ...summarise(trades.filter((t) => matches(t, value))),
        })),
      }
    })
    .filter((f) => f.rows.length)
}

/**
 * Statuses are listed from the data rather than from config alone, so a status
 * the trader has since retired still shows the trades that closed under it —
 * they are counted in the totals above, and a row they cannot appear in would
 * make the breakdown fail to add up. Configured ones keep their order.
 */
function statusesPresent(trades, config) {
  const present = new Set(trades.map((t) => t.status).filter(Boolean))
  const configured = statusList(config)
  const known = configured.filter((s) => present.has(s))
  const extra = [...present].filter((s) => !configured.includes(s)).sort()
  return [...known, ...extra]
}

/**
 * Computes the page.
 *
 * @param {object[]} trades executed trades only — vetoes and backtest entries
 *   are filtered out by the caller, because every block here is a P&L block.
 * @param {object|null} config the trader's config, which names and orders the
 *   user-defined breakdowns. Without it the page still renders every block that
 *   comes out of a column.
 */
export function computeStatistics(trades = [], config = null) {
  return {
    totals: totals(trades),
    extremes: extremes(trades),
    averages: averages(trades),
    curve: curve(trades),
    byDirection: group(
      trades,
      DIRECTIONS.map((d) => ({ key: { field: 'direction', value: d }, label: d }))
    ),
    byStatus: group(
      trades,
      statusesPresent(trades, config).map((s) => ({ key: { field: 'status', value: s }, label: s }))
    ),
    byField: byField(trades, config),
  }
}
