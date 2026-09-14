/**
 * The tiles above the trade table, and which of them a trader wants.
 *
 * Same split as table-columns.js: this says what exists and what is selected,
 * `journal/index.js` says how each one draws. Unlike columns, every tile here is
 * computed — there is no user-defined tile, because a tile is one number over
 * the whole selection and the app has no way to know what arithmetic a buyer
 * would want done to their own field.
 *
 * Stored in `config.visible_stats`.
 */

/**
 * `why` is shown in Settings, not on the tile. Several of these are easy to
 * misread — profit factor and average R are different questions — and the place
 * to explain that is where the trader decides whether to keep it.
 */
export const HEADER_TILES = [
  { id: 'count', label: 'Trades', why: 'Closed trades in view. Vetoes are counted separately.' },
  { id: 'winRate', label: 'Win rate', why: 'Share of closed trades that made money. Says nothing about how much.' },
  { id: 'netPnl', label: 'Net P&L', why: 'The total. The one number that is simply true.' },
  { id: 'profitFactor', label: 'Profit factor', why: 'Gross wins ÷ gross losses. Above 1 is profitable.' },
  { id: 'avgWin', label: 'Avg win', why: 'Mean of the winners alone.' },
  { id: 'avgLoss', label: 'Avg loss', why: 'Mean of the losers alone. Read beside win rate, not instead of it.' },
  { id: 'avgR', label: 'Avg R', why: 'Mean of P&L ÷ risk. Only over trades that recorded a risk.' },
  {
    id: 'vetoes',
    label: 'Vetoes',
    why: 'Ideas you passed on. Shown only once there is at least one, and never folded into the tiles beside it.',
  },
]

export const DEFAULT_VISIBLE_STATS = HEADER_TILES.map((t) => t.id)

const TILE_IDS = new Set(DEFAULT_VISIBLE_STATS)

/**
 * The tiles to render, resolved against what exists.
 *
 * An empty stored list means "all", not "none": a header strip with nothing in
 * it reads as a page that failed to load, and a trader who wanted no tiles at
 * all would have said so by hiding them one at a time — which leaves at least
 * one. Unknown ids are dropped rather than rendered blank.
 */
export function visibleTiles(config) {
  const stored = config?.visible_stats
  if (!Array.isArray(stored) || !stored.length) return HEADER_TILES

  const wanted = stored.filter((id) => TILE_IDS.has(id))
  if (!wanted.length) return HEADER_TILES

  // Ordered by the canonical list, not by the stored one: the tiles read as a
  // sentence — how many, how often, how much — and letting them be reordered
  // would be a lot of UI for a strip of eight numbers.
  return HEADER_TILES.filter((t) => wanted.includes(t.id))
}
