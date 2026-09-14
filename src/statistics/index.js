import { defineAgent } from '../agents/contract.js'
import { listTrades } from '../journal/trades.js'
import { listAccounts } from '../journal/accounts.js'
import { byScope, SCOPES } from '../journal/filters.js'
import { backtestAccountIds } from '../domain/account-vocab.js'
import { isRealTrade } from '../domain/veto-vocab.js'
import { getConfig } from '../journal/settings.js'
import { computeStats, fmtMoney, fmtNum } from '../journal/stats.js'
import { computeStatistics } from './compute.js'
import { publishSummary } from '../lib/summary.js'
import { directionBadge, statusBadge } from '../lib/trade-badges.js'
import { esc, explainFailure } from '../lib/ui-text.js'

/**
 * Performance overview. Reads the same `listTrades` the journal does and does
 * every calculation in `compute.js` — no new queries, no new columns.
 *
 * Each block below is one `renderX(stats)` returning a string. Adding a block
 * is a function here plus a key in `computeStatistics`.
 */

const money = (n) => (n === null ? '—' : fmtMoney(n))
const tone = (n) => (n === null ? 'neu' : n > 0 ? 'pos' : n < 0 ? 'neg' : 'neu')

const statCard = (label, value, cls = 'neu') => `
  <div class="stat-card">
    <div class="stat-label">${label}</div>
    <div class="stat-val ${cls}">${value}</div>
  </div>
`

function renderTotals({ totals }) {
  return `
    <div class="stats-grid">
      ${statCard('Total trades', totals.total)}
      ${statCard('Winners', totals.wins, 'pos')}
      ${statCard('Losers', totals.losses, 'neg')}
      ${statCard('Breakeven', totals.breakeven)}
    </div>
  `
}

function renderPairs({ extremes, averages }) {
  return `
    <div class="pair-grid">
      ${statCard('Best trade', money(extremes.best), tone(extremes.best))}
      ${statCard('Worst trade', money(extremes.worst), tone(extremes.worst))}
      ${statCard('Avg winner', money(averages.avgWinner), tone(averages.avgWinner))}
      ${statCard('Avg loser', money(averages.avgLoser), tone(averages.avgLoser))}
      ${statCard('Avg R', averages.avgR === null ? '—' : `${fmtNum(averages.avgR)}R`)}
      ${statCard('Profit factor', fmtNum(averages.profitFactor))}
    </div>
  `
}

/**
 * Bars are scaled against the largest absolute cumulative value, so a curve
 * that dips negative and recovers keeps both halves readable. Height is capped
 * at the chart's own height in CSS; the minimum keeps a near-zero bar visible.
 */
function renderChart({ curve }) {
  if (!curve.length) {
    return `<section class="panel">
      <h2 class="panel-title">Cumulative P&amp;L</h2>
      <p class="muted">No trades yet.</p>
    </section>`
  }

  const peak = Math.max(...curve.map((p) => Math.abs(p.cumulative)), 1)

  const bars = curve
    .map((p) => {
      const height = Math.max(4, Math.round((Math.abs(p.cumulative) / peak) * 100))
      const cls = p.cumulative >= 0 ? 'up' : 'down'
      const title = `#${esc(p.num ?? '?')} · ${fmtMoney(p.cumulative)}`
      return `<div class="chart-bar ${cls}" style="height:${height}%" title="${title}"></div>`
    })
    .join('')

  return `
    <section class="panel">
      <h2 class="panel-title">Cumulative P&amp;L</h2>
      <div class="chart">${bars}</div>
    </section>
  `
}

const breakdownRow = (row, pill) => `
  <div class="break-row">
    ${pill}
    <span class="break-meta">
      ${row.count} trade${row.count === 1 ? '' : 's'}${
        row.winRate === null ? '' : ` · ${row.winRate}% WR`
      }
    </span>
    <span class="break-pnl ${row.pnl >= 0 ? 'ok' : 'bad'}">${fmtMoney(row.pnl)}</span>
  </div>
`

function renderBreakdowns({ byDirection, byStatus }) {
  return `
    <div class="pair-grid">
      <section class="panel">
        <h2 class="panel-title">By direction</h2>
        ${byDirection.map((row) => breakdownRow(row, directionBadge(row.label))).join('')}
      </section>
      <section class="panel">
        <h2 class="panel-title">By status</h2>
        ${byStatus.map((row) => breakdownRow(row, statusBadge(row.label))).join('')}
      </section>
    </div>
  `
}

/** The sample a number rests on, shown beside it rather than hidden in a title. */
const sample = (n) => `<span class="row-n">n=${n}</span>`

/**
 * A breakdown per user-defined field — the page's whole tagging analysis.
 *
 * Every panel here is one the buyer created. There is no built-in list: define
 * a field called "Session" and its panel appears, rename it and the heading
 * changes, delete it and the panel goes while the trades stay counted in the
 * totals above.
 *
 * Multi-value fields say so, because their rows deliberately sum to more than
 * the trade count — one trade wearing two tags is in two rows — and a reader
 * adding the P&L column up would otherwise double-count it.
 */
function renderFields({ byField }) {
  if (!byField.length) {
    return `<section class="panel">
      <h2 class="panel-title">Your fields</h2>
      <p class="muted">No fields defined yet. Anything you want broken down here — setup, session,
        mood, entry quality — is a field you add in Settings, and it appears as its own panel.</p>
    </section>`
  }

  return `
    <div class="pair-grid">
      ${byField
        .map(
          (field) => `
        <section class="panel">
          <h2 class="panel-title">${esc(field.label)}${
            field.multi ? ` <span class="row-n">multi-select</span>` : ''
          }</h2>
          ${field.rows
            .map((row) => breakdownRow(row, `<span class="badge badge-be">${esc(row.label)}</span>`))
            .join('')}
          ${
            field.multi
              ? `<p class="muted audit-explain">A trade can carry several of these, so these rows
                   add up to more than the trade count.</p>`
              : ''
          }
        </section>`
        )
        .join('')}
    </div>
  `
}

const BLOCKS = [renderTotals, renderPairs, renderChart, renderBreakdowns, renderFields]

export const statistics = defineAgent({
  id: 'statistics',
  title: 'Statistics',
  subtitle: 'Performance overview',

  async mount(el) {
    el.innerHTML = `<p class="muted">Loading trades…</p>`

    let all
    let accounts
    let config
    try {
      // getConfig answers a failed read with a blank config, so the worst a
      // broken settings row costs this page is the names on its field panels.
      // 'all': this page answers "how am I actually doing", and an archive that
      // quietly shortened the cumulative curve would turn every figure on it
      // into "since the last archive" without saying so.
      ;[{ trades: all }, accounts, config] = await Promise.all([
        listTrades({ archived: 'all' }),
        listAccounts(),
        getConfig(),
      ])
    } catch (err) {
      el.innerHTML = `<p class="err">${esc(explainFailure(err, { prefix: 'Could not load trades' }))}</p>`
      return
    }

    // This page is "how am I actually doing", so it answers over executed
    // trades only. Backtest entries were never filled and vetoes were never
    // taken — including either would put a cumulative P&L curve on screen that
    // no account ever earned. The Backtest journal has its own tiles for the
    // first.
    const live = byScope(all, SCOPES.LIVE, backtestAccountIds(accounts))
    const trades = live.filter(isRealTrade)

    // The sidebar footer reads the same totals the journal publishes, so
    // landing here first still fills it in.
    publishSummary(computeStats(trades))

    // Config names and orders the field panels; it never changes a number.
    const stats = computeStatistics(trades, config)
    el.innerHTML = BLOCKS.map((render) => render(stats)).join('')
  },
})
