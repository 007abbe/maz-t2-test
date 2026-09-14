/**
 * Which columns the journal table can show, and which it does.
 *
 * Two kinds, and the difference is where the value comes from rather than how
 * it is drawn: a **built-in** reads a column of the `trades` table, a **field**
 * reads one key out of `custom`. Both are just ids in one ordered list, so a
 * trader can put their own "Setup" between Account and Risk and the table has
 * no idea one of those is theirs.
 *
 * Domain-only: this says what exists and what is selected. `journal/index.js`
 * owns how each cell is drawn, because that is presentation and this is not.
 */

/**
 * The columns backed by an actual table column.
 *
 * `trade` and `pnl` are not in here by accident — they are pinned below, and
 * cannot be turned off. A row with no identifier is unclickable, and a trading
 * journal that does not show P&L is not one.
 */
export const BUILTIN_COLUMNS = [
  { id: 'trade', label: 'Trade' },
  { id: 'date', label: 'Date' },
  { id: 'direction', label: 'Dir' },
  { id: 'status', label: 'Status' },
  { id: 'account', label: 'Account' },
  { id: 'strategy', label: 'Strategy' },
  { id: 'risk', label: 'Risk', numeric: true },
  { id: 'pnl', label: 'P&L', numeric: true },
]

/** Columns that are always shown, wherever they sit in the order. */
export const PINNED_COLUMNS = ['trade', 'pnl']

export const DEFAULT_TABLE_COLUMNS = BUILTIN_COLUMNS.map((c) => c.id)

const BUILTIN_IDS = new Set(DEFAULT_TABLE_COLUMNS)

export const isBuiltinColumn = (id) => BUILTIN_IDS.has(id)

/**
 * Every column a config could offer, in the order the settings screen lists
 * them: the built-ins first, then the trader's own fields.
 *
 * A field scoped to one strategy is offered like any other. It will be blank on
 * trades taken under a different strategy, which is the honest rendering — the
 * question was never asked of them.
 */
export function availableColumns(config) {
  return [
    ...BUILTIN_COLUMNS,
    ...(config?.custom_fields ?? []).map((f) => ({
      id: f.id,
      label: f.label,
      field: f,
      numeric: f.type === 'number',
    })),
  ]
}

/**
 * The columns to actually render, resolved against what exists now.
 *
 * Selections are filtered rather than trusted: a field deleted from config
 * leaves its id in `table_columns`, and rendering a column for a question
 * nobody can see any more would be a column of blanks with a stale heading.
 * Pinned columns are re-inserted if a stored selection somehow lacks them.
 */
export function tableColumns(config) {
  const available = availableColumns(config)
  const byId = new Map(available.map((c) => [c.id, c]))

  const selected = Array.isArray(config?.table_columns)
    ? config.table_columns
    : DEFAULT_TABLE_COLUMNS

  const chosen = selected.filter((id) => byId.has(id))

  // Order the survivors by `available` so a pinned column that was missing
  // lands where it belongs rather than on the end.
  const wanted = new Set([...chosen, ...PINNED_COLUMNS])
  const ordered = chosen.filter((id) => wanted.has(id))
  for (const id of PINNED_COLUMNS) {
    if (ordered.includes(id)) continue
    const at = available.findIndex((c) => c.id === id)
    const before = available.slice(0, at).map((c) => c.id)
    const insert = ordered.findIndex((c) => !before.includes(c))
    ordered.splice(insert < 0 ? ordered.length : insert, 0, id)
  }

  return ordered.map((id) => byId.get(id))
}
