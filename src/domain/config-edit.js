/**
 * Every edit the Settings screen can make to a config, as pure functions.
 *
 * Each one takes a config and returns a new one — nothing mutates, nothing
 * saves, nothing touches the DOM. The screen is then a thin layer that calls
 * these and hands the result to `saveConfig`, and the rules that actually
 * matter (a field id is permanent, a strategy id is never reused, deleting a
 * strategy must not orphan its fields) are testable without a browser.
 *
 * The rule underneath all of them: **ids are permanent, labels are free.**
 * Trades store ids (§4.2), so renaming anything must never produce a new id,
 * and deleting something must never silently re-key what is already stored.
 */

import {
  BLANK_CONFIG,
  SCHEMA_VERSION,
  availableStrategyIds,
  customField,
  fieldId,
  migrate,
} from './config.js'
import { DEFAULT_STATUSES } from './trade-vocab.js'
import { DEFAULT_TABLE_COLUMNS, PINNED_COLUMNS, tableColumns } from './table-columns.js'
import { DEFAULT_VISIBLE_STATS, visibleTiles } from './header-tiles.js'

const clone = (config) => migrate({ ...config })

// --- strategies -----------------------------------------------------------

/** How many strategies a journal can define, fixed by the id list. */
export const MAX_STRATEGIES = 4

/**
 * Adds a strategy under the next unused id.
 *
 * Ids come from the fixed `STRATEGY_IDS` list rather than being generated, and
 * a deleted strategy's id becomes available again. That is a deliberate
 * trade-off: it keeps stored values short and readable, and the cost — trades
 * tagged with a deleted strategy re-attaching to a new one that reuses its id —
 * only bites a trader who deletes a strategy and then adds another. `deleteStrategy`
 * is the place that warns about it.
 */
export function addStrategy(config, label) {
  const name = String(label ?? '').trim()
  if (!name) throw new Error('Give the strategy a name')

  const next = clone(config)
  const [id] = availableStrategyIds(next)
  if (!id) throw new Error(`That is the maximum of ${MAX_STRATEGIES} strategies`)

  next.strategies = [...next.strategies, { id, label: name }]
  return next
}

/** Renames one strategy. The id — and therefore every trade — is untouched. */
export function renameStrategy(config, id, label) {
  const name = String(label ?? '').trim()
  if (!name) throw new Error('A strategy needs a name')

  const next = clone(config)
  next.strategies = next.strategies.map((s) => (s.id === id ? { ...s, label: name } : s))
  return next
}

/**
 * Removes a strategy, and every field scoped to it.
 *
 * The fields go because they have nowhere to be shown: a field scoped to a
 * strategy that no longer exists would never render in the form, so it would
 * look deleted while quietly staying in config forever. Trades already tagged
 * with the strategy keep their `strategy` value and their answers — the stats
 * fall back to showing the raw id, which is what `strategyLabel` and
 * `groupByCustom` do for exactly this case.
 */
export function deleteStrategy(config, id) {
  const next = clone(config)
  next.strategies = next.strategies.filter((s) => s.id !== id)
  next.custom_fields = next.custom_fields.filter((f) => f.strategy !== id)
  return next
}

/** Fields that would be removed along with a strategy, so the UI can say so. */
export const fieldsLostWith = (config, id) =>
  (config.custom_fields ?? []).filter((f) => f.strategy === id)

// --- fields ---------------------------------------------------------------

/**
 * Adds a field with a freshly generated, permanent id.
 *
 * The id is generated here and never again: `updateField` below rewrites every
 * other property but leaves it alone, which is what makes renaming a field a
 * relabelling rather than a data migration.
 */
export function addField(config, { label, type = 'text', strategy = null } = {}) {
  const name = String(label ?? '').trim()
  if (!name) throw new Error('Give the field a name')

  const next = clone(config)
  next.custom_fields = [
    ...next.custom_fields,
    customField({ id: fieldId(), label: name, type, strategy }),
  ]
  return next
}

/**
 * Rewrites one field, keeping its id.
 *
 * Changing a field's *type* is allowed and is not destructive to config, but it
 * can strand answers already stored — turning a multi-select into a text field
 * leaves arrays in `custom` that the new control cannot show. Nothing is
 * rewritten here, because rewriting stored trades from a settings screen is a
 * migration in disguise; the screen warns instead, and `groupByCustom` keeps
 * reporting the old answers either way.
 */
export function updateField(config, id, patch) {
  const next = clone(config)
  next.custom_fields = next.custom_fields.map((f) => {
    if (f.id !== id) return f
    const merged = customField({ ...f, ...patch, id: f.id })
    if (!merged.label.trim()) throw new Error('A field needs a name')
    return merged
  })
  return next
}

/**
 * Removes a field from config.
 *
 * The answers stay in every trade's `custom`. That is on purpose: the stats
 * discover fields from the trades rather than from config, so a deleted field
 * still reports the history it collected instead of vanishing while its trades
 * stay in the totals. Re-adding a field creates a *new* id, so the old answers
 * do not silently reattach to it.
 */
export function deleteField(config, id) {
  const next = clone(config)
  next.custom_fields = next.custom_fields.filter((f) => f.id !== id)
  return next
}

/** Moves a field one place up or down, which is the order the form renders. */
export function moveField(config, id, delta) {
  const next = clone(config)
  const from = next.custom_fields.findIndex((f) => f.id === id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= next.custom_fields.length) return next

  const fields = [...next.custom_fields]
  const [moved] = fields.splice(from, 1)
  fields.splice(to, 0, moved)
  next.custom_fields = fields
  return next
}

// --- options and buckets --------------------------------------------------

/**
 * Replaces a select's options from one line-per-option textarea.
 *
 * Blank lines are dropped and duplicates collapse, keeping the first. An option
 * removed here still shows in the stats for the trades that answered it — see
 * `valuesPresent` in statistics/compute.js — so this is not a destructive edit.
 */
export function setOptions(config, id, text) {
  const options = []
  for (const line of String(text ?? '').split('\n')) {
    const v = line.trim()
    if (v && !options.includes(v)) options.push(v)
  }
  return updateField(config, id, { options })
}

/**
 * Replaces a number field's buckets from a comma-separated list of upper
 * bounds, plus an open-ended bucket for everything above the last one.
 *
 * "10, 30" becomes `≤10`, `10–30`, `30+`. Bounds are what a trader can
 * reasonably type; the labels are derived so they cannot drift out of step with
 * the numbers they describe — a bucket labelled "0–10s" whose bound was edited
 * to 30 would misreport the group with a straight face.
 *
 * An empty list clears the buckets, which leaves the field recorded but never
 * grouped. That is the honest default for a price.
 */
export function setBuckets(config, id, text, unit = '') {
  const bounds = []
  for (const part of String(text ?? '').split(',')) {
    const n = Number(part.trim())
    if (part.trim() !== '' && Number.isFinite(n) && !bounds.includes(n)) bounds.push(n)
  }
  bounds.sort((a, b) => a - b)

  const buckets = bounds.map((max, i) => ({
    label: i === 0 ? `≤${max}${unit}` : `${bounds[i - 1]}–${max}${unit}`,
    max,
  }))
  if (buckets.length) {
    buckets.push({ label: `${bounds[bounds.length - 1]}${unit}+`, max: null })
  }

  return updateField(config, id, { buckets })
}

/** The bounds a bucket list was built from, for editing it back. */
export const bucketBounds = (field) =>
  (field?.buckets ?? [])
    .map((b) => b.max)
    .filter((m) => m !== null && m !== undefined)
    .join(', ')

// --- statuses -------------------------------------------------------------

/**
 * Replaces the status list from one line-per-status textarea.
 *
 * Removing a status is not destructive: `status` is free text on the row, and
 * the statistics list the statuses actually present rather than a fixed set, so
 * trades that closed as "TP" keep saying so after the word is retired. What
 * changes is only what the log form offers next time.
 *
 * An empty list falls back to the defaults rather than being stored, because a
 * form with no statuses to pick from cannot record how a trade finished.
 */
export function setStatuses(config, text) {
  const statuses = []
  for (const line of String(text ?? '').split('\n')) {
    const v = line.trim()
    if (v && !statuses.includes(v)) statuses.push(v)
  }

  const next = clone(config)
  next.statuses = statuses.length ? statuses : [...DEFAULT_STATUSES]
  return next
}

// --- money ----------------------------------------------------------------

/**
 * The symbol every P&L figure is written with.
 *
 * A symbol, not a currency code and not a locale: the app never converts and
 * never formats by region, it prefixes a number. Storing "USD" would imply an
 * exchange rate somewhere, and there is not one.
 */
export function setCurrency(config, symbol) {
  const next = clone(config)
  const s = String(symbol ?? '').slice(0, 4)
  next.currency = s.trim() || s === ' ' ? s : '$'
  return next
}

// --- table columns --------------------------------------------------------

/**
 * Turns one column on or off, keeping the order the trader chose.
 *
 * A column being switched on lands in its natural position rather than on the
 * end — the order in `availableColumns` — so toggling Status off and on again
 * does not quietly move it past Account.
 */
export function toggleColumn(config, id, on) {
  const next = clone(config)
  const current = tableColumns(next).map((c) => c.id)

  if (!on) {
    if (PINNED_COLUMNS.includes(id)) return next
    next.table_columns = current.filter((c) => c !== id)
    return next
  }

  if (current.includes(id)) return next

  // Insert by natural order: after the last selected column that naturally
  // precedes this one.
  const natural = availableOrder(next)
  const rank = (c) => {
    const i = natural.indexOf(c)
    return i < 0 ? natural.length : i
  }
  const at = current.findIndex((c) => rank(c) > rank(id))
  const list = [...current]
  list.splice(at < 0 ? list.length : at, 0, id)
  next.table_columns = list
  return next
}

const availableOrder = (config) => [
  ...DEFAULT_TABLE_COLUMNS,
  ...(config.custom_fields ?? []).map((f) => f.id),
]

/** Moves a column one place left or right in the table. */
export function moveColumn(config, id, delta) {
  const next = clone(config)
  const current = tableColumns(next).map((c) => c.id)
  const from = current.indexOf(id)
  const to = from + delta
  if (from < 0 || to < 0 || to >= current.length) return next

  const list = [...current]
  const [moved] = list.splice(from, 1)
  list.splice(to, 0, moved)
  next.table_columns = list
  return next
}

// --- header tiles ---------------------------------------------------------

/**
 * Turns one header tile on or off.
 *
 * The last tile cannot be turned off. An empty strip reads as a page that
 * failed to load rather than as a choice, and `visibleTiles` treats an empty
 * list as "all" anyway — so storing one would silently turn every tile back on
 * the next time the journal loaded.
 */
export function toggleTile(config, id, on) {
  const next = clone(config)
  const current = visibleTiles(next).map((t) => t.id)

  if (on) {
    if (current.includes(id)) return next
    next.visible_stats = DEFAULT_VISIBLE_STATS.filter((t) => current.includes(t) || t === id)
    return next
  }

  const remaining = current.filter((t) => t !== id)
  if (!remaining.length) throw new Error('Keep at least one tile')
  next.visible_stats = remaining
  return next
}

// --- onboarding -----------------------------------------------------------

/**
 * Marks the walkthrough done, whether it was completed or skipped.
 *
 * Skipping counts. Someone who chose to start blank has made a decision, and
 * greeting them with the same card every morning would turn a welcome into
 * nagging.
 */
export const completeOnboarding = (config) => {
  const next = clone(config)
  next.onboarded = true
  return next
}

/** Puts the walkthrough back, for the "run it again" button in Settings. */
export const restartOnboarding = (config) => {
  const next = clone(config)
  next.onboarded = false
  return next
}

// --- whole-config operations ----------------------------------------------

/**
 * Replaces the config with a preset's, keeping what is not the preset's to
 * decide — the schema version, and the theme, which is a display preference
 * rather than a description of how the trader trades.
 *
 * Destructive on purpose and not merged: a preset half-applied over an existing
 * setup produces a field list nobody designed, with two fields called "Setup"
 * scoped to the same strategy. The screen confirms before calling this.
 */
export function applyPreset(config, preset) {
  if (!preset) throw new Error('Pick a preset')

  return migrate({
    ...BLANK_CONFIG,
    ...preset.config,
    schema_version: SCHEMA_VERSION,
    ...kept(config),
  })
}

/** Back to nothing, keeping the display preferences for the same reason. */
export const clearConfig = (config) => migrate({ ...BLANK_CONFIG, ...kept(config) })

/**
 * What survives a preset or a clear: how the app *looks*, as opposed to how the
 * trader trades. A preset has an opinion about setups; it has none about
 * whether you read in the dark or price in kronor.
 */
const kept = (config) => ({
  theme: config?.theme ?? BLANK_CONFIG.theme,
  currency: config?.currency ?? BLANK_CONFIG.currency,
  // Clearing the config is not the same as forgetting the trader: someone
  // starting their vocabulary over should not be walked through the app again.
  onboarded: !!config?.onboarded,
})
