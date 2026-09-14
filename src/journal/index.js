import { listTrades } from './trades.js'
import { getConfig } from './settings.js'
import { listAccounts, rememberedFilter, rememberFilter } from './accounts.js'
import { openAccountsModal } from './accounts-ui.js'
import { computeStats, fmtMoney, fmtNum } from './stats.js'
import { openTradeForm } from './form.js'
import {
  applyFilters, byAccount, byScope, tradeLabel, ARCHIVE_VIEWS, SORTS, DIRECTIONS,
  NO_FILTERS, UNASSIGNED, SCOPES,
} from './filters.js'
import { ARCHIVE_KEEP, ARCHIVE_THRESHOLD, archiveOldTrades } from './trades.js'
import { statusList } from '../domain/trade-vocab.js'
import { tableColumns } from '../domain/table-columns.js'
import { visibleTiles } from '../domain/header-tiles.js'
import { backtestAccountIds } from '../domain/account-vocab.js'
import { isVeto } from '../domain/veto-vocab.js'
import { strategyLabel } from '../domain/config.js'
import { publishSummary } from '../lib/summary.js'
import { directionBadge, statusBadge } from '../lib/trade-badges.js'
import { accountName } from '../lib/account-badges.js'
import { currencySymbol } from '../lib/display.js'
import { renderOnboarding } from '../onboarding/index.js'
import { esc, explainFailure } from '../lib/ui-text.js'

const statTile = (label, value, cls = '', title = '') =>
  `<div class="stat"${title ? ` title="${esc(title)}"` : ''}>
     <span class="stat-label">${label}</span><b class="${cls}">${value}</b>
   </div>`

/**
 * How each tile draws itself, keyed by the ids in domain/header-tiles.js.
 *
 * A renderer may return '' to decline: `vetoes` does, until there is at least
 * one. An always-on "Vetoes 0" would take a slot from a number doing work.
 */
const TILES = {
  count: (s) => statTile('Trades', s.count),
  winRate: (s) => statTile('Win rate', `${s.winRate}%`),
  netPnl: (s) => statTile('Net P&amp;L', fmtMoney(s.netPnl), s.netPnl >= 0 ? 'ok' : 'bad'),
  profitFactor: (s) => statTile('Profit factor', fmtNum(s.profitFactor)),
  avgWin: (s) => statTile('Avg win', fmtMoney(s.avgWin), 'ok'),
  avgLoss: (s) => statTile('Avg loss', fmtMoney(-s.avgLoss), 'bad'),
  avgR: (s) => statTile('Avg R', fmtNum(s.avgR)),
  vetoes: (s) =>
    s.vetoes
      ? statTile('Vetoes', s.vetoes, 'veto-stat', 'Ideas you passed on. Excluded from every tile beside it.')
      : '',
}

function renderStats(stats, config) {
  return `
    <div class="stats">
      ${visibleTiles(config)
        .map((tile) => TILES[tile.id]?.(stats) ?? '')
        .join('')}
    </div>
  `
}

const option = (value, label, selected) =>
  `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`

/**
 * "Both" first, and it is the default. A veto you cannot see by default is a
 * veto you stop bothering to log.
 */
const KIND_OPTIONS = [
  { value: '', label: 'Trades & vetoes' },
  { value: 'trade', label: 'Trades only' },
  { value: 'veto', label: 'Vetoes only' },
]

function renderFilters(filters, accounts, scope, statuses) {
  const backtest = scope === SCOPES.BACKTEST
  return `
    <div class="filters">
      <input class="search-box" type="search" id="f-search" placeholder="Search number or thesis…"
             value="${esc(filters.search)}" aria-label="Search trades">
      <select class="filter-select" id="f-kind" aria-label="Filter by entry kind">
        ${KIND_OPTIONS.map((k) => option(k.value, k.label, filters.kind)).join('')}
      </select>
      <select class="filter-select" id="f-status" aria-label="Filter by status">
        ${option('', 'All statuses', filters.status)}
        ${statuses.map((s) => option(s, s, filters.status)).join('')}
      </select>
      <select class="filter-select" id="f-direction" aria-label="Filter by direction">
        ${option('', 'All directions', filters.direction)}
        ${DIRECTIONS.map((d) => option(d, d, filters.direction)).join('')}
      </select>
      <select class="filter-select" id="f-archived" aria-label="Show archived trades">
        ${ARCHIVE_VIEWS.map((v) => option(v.value, v.label, filters.archived)).join('')}
      </select>
      <select class="filter-select" id="f-sort" aria-label="Sort trades">
        ${SORTS.map((s) => option(s.value, s.label, filters.sort)).join('')}
      </select>
      <select class="filter-select" id="f-account" aria-label="Filter by account">
        ${option('', backtest ? 'All backtest accounts' : 'All accounts', filters.account)}
        ${accounts.map((a) => option(a.id, a.name, filters.account)).join('')}
        ${backtest ? '' : option(UNASSIGNED, 'Unassigned', filters.account)}
      </select>
      <button type="button" class="ghost btn-accounts" data-act="accounts">Accounts</button>
      <button type="button" class="ghost btn-accounts btn-scope" data-act="switch-scope">
        ${backtest ? 'Journal' : 'Backtest'}
      </button>
    </div>
  `
}

/** Risk as a whole figure, or an em dash when unrecorded. Unsigned: risk has
 *  no direction, so the leading + or - that `fmtMoney` adds would be noise. */
const fmtRisk = (risk) => {
  const n = Number(risk ?? 0)
  return n > 0 ? `${currencySymbol()}${n.toFixed(0)}` : '—'
}

/**
 * How each column draws itself.
 *
 * Keyed by the ids in domain/table-columns.js, which decides what *exists*;
 * this decides what it looks like. Anything not in here is a user-defined
 * field, and falls through to `customCell` — so a trader adding a field and
 * putting it in the table needs no code at all.
 *
 * Risk and P&L are blanked on a veto rather than shown as 0: it was never
 * filled, and a column of zeroes reads as a run of scratched trades.
 */
const CELLS = {
  trade: (t, ctx) =>
    `<td class="mono">${esc(tradeLabel(t, ctx.instrument))}${
      ctx.veto ? '<span class="badge badge-veto">Veto</span>' : ''
    }</td>`,
  date: (t) => `<td class="mono">${esc(t.date ?? '')}</td>`,
  direction: (t) => `<td>${directionBadge(t.direction)}</td>`,
  status: (t, ctx) =>
    `<td>${ctx.veto ? '<span class="acct-none">—</span>' : statusBadge(t.status)}</td>`,
  account: (t, ctx) => `<td class="acct-cell">${accountName(ctx.accountsById.get(t.account_id))}</td>`,
  // The trade stores a strategy id (§4.2); this is the one place it becomes a
  // name, so renaming a strategy renames a column of cells and moves no data.
  strategy: (t, ctx) => `<td>${esc(strategyLabel(ctx.config, t.strategy))}</td>`,
  risk: (t, ctx) => `<td class="num risk-cell">${ctx.veto ? '—' : fmtRisk(t.risk)}</td>`,
  pnl: (t, ctx) => {
    const pnl = Number(t.pnl ?? 0)
    return `<td class="num ${ctx.veto ? '' : pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${
      ctx.veto ? '—' : fmtMoney(pnl)
    }</td>`
  },
}

/**
 * A user-defined field, in a table cell.
 *
 * Multi-value answers are joined rather than rendered as pills — a table row is
 * one line high, and three pills in a cell would push it to two. A trade that
 * never answered shows nothing at all, not an em dash: on a field scoped to
 * another strategy that is not missing data, it is a question that was never
 * asked of this trade.
 */
function customCell(field, trade) {
  const value = trade.custom?.[field.id]
  const text =
    value === true
      ? 'Yes'
      : Array.isArray(value)
        ? value.join(', ')
        : value === null || value === undefined
          ? ''
          : String(value)

  return `<td class="${field.type === 'number' ? 'num ' : ''}cell-field">${esc(text)}</td>`
}

function renderRows(trades, columns, ctx) {
  return trades
    .slice(0, 50)
    .map((t) => {
      const rowCtx = { ...ctx, veto: isVeto(t) }
      const cells = columns
        .map((col) => (CELLS[col.id] ? CELLS[col.id](t, rowCtx) : customCell(col.field, t)))
        .join('')

      return `<tr data-id="${esc(t.id)}" tabindex="0" class="${rowCtx.veto ? 'row-veto' : ''}">${cells}</tr>`
    })
    .join('')
}

/**
 * The two things the trader has to be told about their own data volume.
 *
 * `truncated` means a read hit its page ceiling and the journal is showing part
 * of the book. It is loud and red because every tile above it is then computed
 * over a slice — the one failure this product must never present quietly.
 *
 * The archive offer is the opposite: nothing is wrong, the working list has
 * simply grown past the point where it is useful to scroll. It is an offer and
 * not an automatic action because it rewrites hundreds of rows, and a journal
 * that silently reorganises itself is one you stop trusting.
 */
function renderNotices({ truncated, activeCount, archivedCount, filters }) {
  const notices = []

  if (truncated) {
    notices.push(`<p class="err notice-row">
      This journal is larger than one read can return, so the numbers above cover
      only part of it. Archive older trades, or the figures will stay incomplete.
    </p>`)
  }

  if (activeCount > ARCHIVE_THRESHOLD) {
    notices.push(`<p class="notice-row notice-offer">
      <span><b>${activeCount} active trades.</b> Archiving keeps the list quick to work
      in — the newest ${ARCHIVE_KEEP} stay here, the rest move to Archived. Every tile
      and every statistic still counts all of them.</span>
      <button type="button" class="ghost" data-act="archive">
        Archive the oldest ${activeCount - ARCHIVE_KEEP}
      </button>
    </p>`)
  }

  if (archivedCount && filters.archived === 'active') {
    notices.push(`<p class="notice-row muted">
      ${archivedCount} archived trade${archivedCount === 1 ? '' : 's'} not listed below.
      They are still counted in every figure above — switch the filter to see them.
    </p>`)
  }

  return notices.join('')
}

/** What an empty table should say, which depends on why it is empty. */
function emptyMessage(scope, hasAccounts) {
  if (scope !== SCOPES.BACKTEST) return 'No trades yet. Log your first one.'
  return hasAccounts
    ? 'No backtest entries yet. Log your first one.'
    : 'No backtest accounts yet. Open Accounts → New account and pick the Backtest type, then log against it.'
}

function renderTable(visible, total, ctx, scope, hasAccounts, filters) {
  if (!total) return `<p class="muted">${esc(emptyMessage(scope, hasAccounts))}</p>`
  if (!visible.length) {
    return `<p class="muted">${
      filters.archived === 'archived'
        ? 'Nothing archived yet.'
        : 'No entries match these filters.'
    }</p>`
  }

  // Resolved per paint rather than once per mount: a column pointing at a field
  // deleted in another tab has to drop out, not render a stale heading over a
  // column of blanks.
  const columns = tableColumns(ctx.config)

  return `
    <div class="table-wrap">
      <table class="trades">
        <thead><tr>
          ${columns
            .map((c) => `<th${c.numeric ? ' class="num"' : ''}>${esc(c.label)}</th>`)
            .join('')}
        </tr></thead>
        <tbody>${renderRows(visible, columns, ctx)}</tbody>
      </table>
    </div>
    <p class="muted">Showing ${Math.min(visible.length, 50)} of ${visible.length}${
      visible.length === total ? '' : ` (${total} total)`
    }. Click a row to edit.</p>
  `
}

/**
 * Renders the journal into `el`.
 *
 * Filtering is local state: `listTrades` runs once per mount, and every filter
 * change re-renders the table from the array already in memory. The account
 * list is fetched alongside it — it names the dropdown's options, colours the
 * table's Account column, and decides which of the two journals each trade
 * belongs to.
 *
 * `scope` picks that journal. Both are this same view over a different slice:
 * the live one, and the one over Backtest accounts. Sharing the implementation
 * is the point — a backtest is only worth keeping if it is journalled to the
 * same standard as a real trade, which means the same fields and the same
 * filters.
 */
export async function renderJournal(el, { header, navigate, scope = SCOPES.LIVE } = {}) {
  el.innerHTML = `<p class="muted">Loading trades…</p>`

  let allTrades
  let allAccounts
  let config
  let truncated = false
  try {
    // getConfig answers a failed read with a blank config, so it cannot be the
    // thing that stops the journal loading.
    // 'all', not the working list: the tiles below are lifetime figures, and an
    // archive that quietly shrank them would turn "Net P&L" into "P&L since the
    // last archive" without a word on screen. Only the *table* hides archived
    // trades, and it says how many it is hiding.
    let loaded
    ;[loaded, allAccounts, config] = await Promise.all([
      listTrades({ archived: 'all' }),
      listAccounts(),
      getConfig(),
    ])
    allTrades = loaded.trades
    truncated = loaded.truncated
  } catch (err) {
    el.innerHTML = `<p class="err">${esc(explainFailure(err, { prefix: 'Could not load trades' }))}</p>`
    return
  }

  // First run. Shown in place of the journal rather than over it: a modal traps
  // someone who only wanted to look around, and the nav visible beside this is
  // itself part of what the walkthrough is explaining. Live scope only — the
  // backtest journal is not where anyone lands first.
  if (!config.onboarded && scope === SCOPES.LIVE) {
    if (header) header.innerHTML = ''
    // Into a child of its own, not into `el`: the walkthrough binds listeners to
    // the element it is given, and re-rendering the journal over the top would
    // leave them attached to a node that is no longer there. Held as a
    // reference rather than looked up by id afterwards — there is then no step
    // between creating the element and handing it over that could go wrong.
    const host = document.createElement('div')
    el.replaceChildren(host)
    renderOnboarding(host, config, () => renderJournal(el, { header, navigate, scope }))
    return
  }

  // The partition happens once, here, and everything below works on `trades`.
  // Doing it at the top rather than inside each filter is what makes it
  // impossible for a tile, the sidebar or the table to disagree about which
  // journal is on screen.
  const backtestIds = backtestAccountIds(allAccounts)
  const wantBacktest = scope === SCOPES.BACKTEST
  const trades = byScope(allTrades, scope, backtestIds)
  const accounts = allAccounts.filter((a) => backtestIds.has(a.id) === wantBacktest)

  const accountsById = new Map(allAccounts.map((a) => [a.id, a]))

  const reload = () => renderJournal(el, { header, navigate, scope })

  // Saving a trade remounts this whole view, so the selected account has to
  // outlive the mount — otherwise editing a trade would drop the trader back to
  // all-accounts totals without them touching the dropdown. Remembered per
  // scope: the two journals do not share a selection.
  const filters = {
    ...NO_FILTERS,
    account: rememberedFilter(accounts.map((a) => a.id), wantBacktest ? [] : [UNASSIGNED], scope),
    // Search matches the label as rendered, so it needs the same instrument.
    instrument: config.instrument ?? '',
  }

  // The tiles and the sidebar answer to the account alone, not to the search
  // box or the status filter — see `byAccount` in filters.js. Vetoes stay in
  // this set: `computeStats` drops them from every P&L number itself and
  // reports the count separately.
  const summarise = () => byAccount(trades, filters.account)

  // The shell owns the topbar; the view owns what goes in it. Clearing first
  // keeps a reload from stacking a second button.
  if (header) {
    header.innerHTML = `<button type="button" class="btn-add" data-act="new">+ Log ${wantBacktest ? 'entry' : 'trade'}</button>`
    header
      .querySelector('[data-act="new"]')
      .addEventListener('click', () => openTradeForm({ scope, onSaved: reload }))
  }

  // The context every cell renderer reads. Built once per mount because none of
  // it changes while filters do.
  const cellContext = {
    config,
    accountsById,
    instrument: config.instrument ?? '',
  }

  el.innerHTML = `
    <div id="trade-stats"></div>
    ${renderFilters(filters, accounts, scope, statusList(config))}
    <div id="trade-notices"></div>
    <div id="trade-table"></div>
  `

  const table = el.querySelector('#trade-table')
  const statsEl = el.querySelector('#trade-stats')
  const notices = el.querySelector('#trade-notices')

  const paint = () => {
    const visible = applyFilters(trades, filters)
    const rows = summarise()
    const stats = computeStats(rows)

    // Tiles, sidebar and table are painted together so they can never disagree
    // about which account is on screen. `trades.length` stays this journal's
    // total: an account with nothing on it has no trades *matching the filters*,
    // which is not the same as having logged none at all.
    statsEl.innerHTML = renderStats(stats, config)
    publishSummary(stats)
    // Counted over this journal's trades, not the filtered view: the offer to
    // archive is about how much has piled up, which a search box must not change.
    const activeCount = trades.filter((t) => !t.archived).length
    notices.innerHTML = renderNotices({
      truncated,
      activeCount,
      archivedCount: trades.length - activeCount,
      filters,
    })

    notices.querySelector('[data-act="archive"]')?.addEventListener('click', async (e) => {
      const button = e.target
      if (
        !confirm(
          `Archive the oldest ${activeCount - ARCHIVE_KEEP} trades?\n\n` +
            `The newest ${ARCHIVE_KEEP} stay in the list. Nothing is deleted, every ` +
            'figure still counts them, and you can restore any of them from the ' +
            'Archived view.'
        )
      ) {
        return
      }
      button.disabled = true
      button.textContent = 'Archiving…'
      try {
        await archiveOldTrades()
        reload()
      } catch (err) {
        button.disabled = false
        button.textContent = 'Archive failed — try again'
        console.error(err)
      }
    })

    table.innerHTML = renderTable(
      visible, trades.length, cellContext, scope, accounts.length, filters
    )

    const openRow = (row) =>
      openTradeForm({ trade: trades.find((t) => t.id === row.dataset.id), scope, onSaved: reload })

    table.querySelectorAll('tr[data-id]').forEach((row) => {
      row.addEventListener('click', () => openRow(row))
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openRow(row)
        }
      })
    })
  }

  const bind = (id, key, event) =>
    el.querySelector(id).addEventListener(event, (e) => {
      filters[key] = e.target.value
      paint()
    })

  bind('#f-search', 'search', 'input')
  bind('#f-kind', 'kind', 'change')
  bind('#f-archived', 'archived', 'change')
  bind('#f-status', 'status', 'change')
  bind('#f-direction', 'direction', 'change')
  bind('#f-sort', 'sort', 'change')

  el.querySelector('#f-account').addEventListener('change', (e) => {
    filters.account = e.target.value
    rememberFilter(filters.account, scope)
    paint()
  })

  // Creating, deleting or assigning changes the dropdown's options and the
  // table's Account column, so the modal reloads the view rather than trying to
  // patch it. It only calls back when something was actually written.
  el.querySelector('[data-act="accounts"]').addEventListener('click', () => {
    openAccountsModal({ scope, onChanged: reload })
  })

  el.querySelector('[data-act="switch-scope"]').addEventListener('click', () => {
    navigate?.(wantBacktest ? 'journal' : 'backtest')
  })

  paint()
}
