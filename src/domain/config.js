/**
 * The user's configuration — the seam that replaces hardcoded trading models.
 *
 * Everything the journal used to know at build time (which strategies exist,
 * what a trade is tagged with, which numbers get recorded alongside it) is read
 * from here instead. The shape lives in the single-row `settings` table as a
 * jsonb blob, so changing any of it is a write, never a migration.
 *
 * Pure and UI-free: no DOM, no fetch. `loadConfig` takes rows, it does not go
 * and get them.
 */

/**
 * Bumped whenever the *shape* of config changes. `migrate` below reads older
 * shapes forward in JavaScript on load, which is what keeps a config change
 * from ever becoming a SQL change. See ARCHITECTURE.md, `config.js` under *The
 * files*.
 */
export const SCHEMA_VERSION = 3

import { DEFAULT_STATUSES } from './trade-vocab.js'
import { DEFAULT_TABLE_COLUMNS } from './table-columns.js'
import { DEFAULT_VISIBLE_STATS } from './header-tiles.js'

/**
 * Strategy ids are internal and fixed; the label is what the trader sees.
 *
 * This is the §4.2 rule applied to the app's own concepts: a trade stores
 * `strategy: 'model_a'`, and renaming "Opening Drive" to "Trend Continuation"
 * six months in is a label edit that leaves every historical trade resolving
 * correctly. Keying trades on the display name instead would orphan them all on
 * the first rename, unfixably.
 */
export const STRATEGY_IDS = ['model_a', 'model_b', 'model_c', 'model_d']

/**
 * What a user-defined field can be.
 *
 * Deliberately short. Every type here is one the stats engine knows how to
 * group: scalars bucket by value, multiselect buckets by each value, and a
 * toggle is a two-value scalar. A type the stats cannot group would be a field
 * you can fill in and never learn anything from.
 *
 *   number — grouped by `buckets` when it has them, otherwise recorded but not
 *            grouped, because one bucket per distinct price is not a finding.
 */
export const FIELD_TYPES = ['text', 'number', 'select', 'multiselect', 'toggle']

/** Types that hold several values at once, and so group into several buckets. */
export const isMultiValue = (field) => field?.type === 'multiselect'

/**
 * A journal with no configuration yet. This is what a first run gets, and what
 * every test starts from.
 *
 * Deliberately empty: t2 ships with no strategies and no fields defined. The
 * first-run wizard writes the buyer's own, seeded from a preset if they pick
 * one. Shipping a "sensible default" set of setups would be shipping somebody
 * else's trading model.
 */
export const BLANK_CONFIG = {
  schema_version: SCHEMA_VERSION,
  instrument: null,
  session: null,
  strategies: [],
  labels: {},
  custom_fields: [],
  // How a trade finished, and what the journal writes money in. Both are
  // structural — every journal has them — so unlike setups and tags they start
  // with a working default rather than empty.
  statuses: [...DEFAULT_STATUSES],
  currency: '$',
  // Which columns the journal table shows, in order. Ids from
  // `table-columns.js`, or a custom field's id.
  table_columns: [...DEFAULT_TABLE_COLUMNS],
  // Which tiles sit above the trade table. Empty means all — see `visibleTiles`.
  visible_stats: [...DEFAULT_VISIBLE_STATS],
  theme: 'dark',
  /**
   * Has the trader seen the walkthrough?
   *
   * Its own flag rather than `isConfigured`, because skipping is a real answer:
   * someone who chose to start blank has been onboarded and must not be greeted
   * by the same card every morning. It is stored, not local, so a second device
   * does not start the walkthrough again.
   */
  onboarded: false,
}

export const THEMES = ['dark', 'light']

/** One strategy as the form and stats expect it. */
export function strategy(id, label) {
  return { id, label }
}

/**
 * Field ids are generated and permanent; only the label is ever edited.
 *
 * Trades store the id (§4.2), so this is the value that must never be derived
 * from the label — slugifying "Setup" would mean renaming the field re-keys
 * every trade that answered it, and the old answers would vanish from the
 * stats without a single error being raised.
 */
export function fieldId() {
  const r = crypto.getRandomValues(new Uint32Array(2))
  return `f_${r[0].toString(36)}${r[1].toString(36)}`
}

/**
 * One user-defined field.
 *
 * `strategy` scopes it: null shows it on every trade, an id shows it only when
 * that strategy is selected. That is how a per-strategy setup list is
 * expressed — as one field per strategy — without the schema needing a concept
 * of a setup at all.
 *
 * `allow_custom` lets the trader answer with something not on the list, which
 * a target level has to allow and a controlled vocabulary must not.
 */
export function customField({
  id = fieldId(),
  label,
  type = 'text',
  options = [],
  buckets = [],
  allow_custom = false,
  strategy = null,
} = {}) {
  return {
    id,
    label,
    type: FIELD_TYPES.includes(type) ? type : 'text',
    options: [...options],
    buckets: [...buckets],
    allow_custom: !!allow_custom,
    strategy: strategy ?? null,
  }
}

/**
 * Reads a stored config forward to the current shape.
 *
 * Always returns a complete object: a config missing a key is not an error, it
 * is an older or hand-edited row, and the journal has to render either way.
 */
export function migrate(stored) {
  const c = stored && typeof stored === 'object' ? stored : {}

  return {
    ...BLANK_CONFIG,
    ...c,
    schema_version: SCHEMA_VERSION,
    strategies: Array.isArray(c.strategies) ? c.strategies.map(normaliseStrategy) : [],
    labels: c.labels && typeof c.labels === 'object' ? { ...c.labels } : {},
    custom_fields: Array.isArray(c.custom_fields)
      ? c.custom_fields.filter((f) => f?.id && isNonEmptyString(f?.label)).map(customField)
      : [],
    statuses: Array.isArray(c.statuses)
      ? c.statuses.map((v) => String(v ?? '').trim()).filter(Boolean)
      : [...DEFAULT_STATUSES],
    // Not validated against what exists — that happens in `tableColumns`, which
    // has to filter anyway because a field can be deleted long after this ran.
    table_columns: Array.isArray(c.table_columns)
      ? c.table_columns.filter(isNonEmptyString)
      : [...DEFAULT_TABLE_COLUMNS],
    // Same as table_columns: `visibleTiles` filters unknown ids anyway, and it
    // reads an empty list as "all" rather than as "none".
    visible_stats: Array.isArray(c.visible_stats)
      ? c.visible_stats.filter(isNonEmptyString)
      : [...DEFAULT_VISIBLE_STATS],
    currency: typeof c.currency === 'string' && c.currency.length ? c.currency.slice(0, 4) : '$',
    onboarded: !!c.onboarded,
    // An unknown theme falls back rather than being kept: it reaches the DOM as
    // a `data-theme` attribute, and a value with no token block behind it would
    // render the app in whatever the browser defaults to.
    theme: THEMES.includes(c.theme) ? c.theme : 'dark',
  }
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

function normaliseStrategy(s) {
  return {
    id: s?.id ?? null,
    label: isNonEmptyString(s?.label) ? s.label : (s?.id ?? 'Untitled'),
  }
}

/** The `settings` row -> config. A missing row is a blank config, not an error. */
export function loadConfig(row) {
  return migrate(row?.config)
}

/** True once the buyer has configured anything at all. Drives the first-run wizard. */
export function isConfigured(config) {
  return !!config && (config.strategies.length > 0 || !!config.instrument)
}

/** Look up a strategy by the id stored on a trade. */
export function findStrategy(config, id) {
  if (!id) return null
  return config.strategies.find((s) => s.id === id) ?? null
}

/**
 * Display text for a stored strategy id.
 *
 * Falls back to the raw id rather than to an em dash: a trade tagged with a
 * strategy the trader has since deleted should still show *something* it can be
 * grouped by, and silently blanking it would make those trades look untagged.
 */
export function strategyLabel(config, id) {
  if (!id) return ''
  return findStrategy(config, id)?.label ?? config.labels?.[id] ?? id
}

/** Strategy ids not yet used, so the settings screen can offer the next one. */
export function availableStrategyIds(config) {
  const used = new Set(config.strategies.map((s) => s.id))
  return STRATEGY_IDS.filter((id) => !used.has(id))
}

/** Every field defined, whatever its scope. */
export const allFields = (config) => config?.custom_fields ?? []

/**
 * The fields to show for a trade on `strategyId`.
 *
 * Unscoped fields first, then the ones belonging to this strategy, so the form
 * reads the same way whichever strategy is selected and only grows a section at
 * the bottom.
 */
export function fieldsFor(config, strategyId) {
  const fields = allFields(config)
  return [
    ...fields.filter((f) => !f.strategy),
    ...(strategyId ? fields.filter((f) => f.strategy === strategyId) : []),
  ]
}

/** Look up a field by the id stored in a trade's `custom` object. */
export function findField(config, id) {
  return allFields(config).find((f) => f.id === id) ?? null
}

/**
 * Display text for a stored field id.
 *
 * Same fallback as `strategyLabel`, for the same reason: a field the trader has
 * deleted still has history in `custom`, and the stats show that history under
 * the raw id rather than dropping it silently.
 */
export function fieldLabel(config, id) {
  return findField(config, id)?.label ?? id
}

/**
 * Coerces a form answer into what should be stored for `field`.
 *
 * Returns undefined for "not answered", which the caller omits from `custom`
 * entirely rather than writing as null — an absent key and a null both read as
 * unanswered, and only one of them costs a row in the jsonb for every field the
 * trader skipped.
 */
export function normaliseFieldValue(field, value) {
  switch (field?.type) {
    case 'number': {
      if (value === null || value === undefined || String(value).trim() === '') return undefined
      const n = Number(value)
      return Number.isFinite(n) ? n : undefined
    }
    case 'toggle':
      // Only `true` is stored. A false toggle is the default state of every
      // trade that never saw the field, so writing it would make "not answered"
      // and "answered no" indistinguishable anyway — at the cost of a key.
      return value ? true : undefined
    case 'multiselect': {
      // A Set as well as an array: the form holds these answers as Sets so a
      // pill can toggle membership, and `[...aSet]` is not what `[value]`
      // produces — that would store the string '[object Set]'.
      const raw =
        value instanceof Set ? [...value] : Array.isArray(value) ? value : [value]
      const list = raw.map((v) => String(v ?? '').trim()).filter(Boolean)
      return list.length ? list : undefined
    }
    default: {
      const s = String(value ?? '').trim()
      return s || undefined
    }
  }
}

/**
 * A trade's `custom` object, rebuilt from the answers the form collected.
 *
 * Only fields currently defined are written. An answer to a field the trader
 * has since deleted is dropped on the next save of that trade — the field is
 * gone from the form, so keeping its value would mean carrying data the trader
 * can no longer see or correct.
 */
export function buildCustom(fields, answers) {
  const out = {}
  for (const field of fields) {
    const value = normaliseFieldValue(field, answers[field.id])
    if (value !== undefined) out[field.id] = value
  }
  return out
}
