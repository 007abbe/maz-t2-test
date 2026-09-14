/**
 * Starting configurations the Settings screen can seed from.
 *
 * A preset is nothing but a config blob — the same shape the screen writes by
 * hand. Applying one is a single write to `settings.config`, and everything it
 * defines can then be renamed, reordered, retyped or deleted like anything the
 * trader created themselves. Nothing here is privileged, and nothing here is
 * required: "start from nothing" is a button on the same screen.
 *
 * The point of shipping presets is that a blank journal is a hard place to
 * start — you have to invent a whole vocabulary before logging a first trade.
 * The point of shipping *three* is that none of them is the right way. They
 * deliberately express similar ideas differently, so a trader can see the
 * machinery's range before deciding what their own should look like:
 *
 *   Target   — Minimal: a free text box.
 *              Intraday: a list to pick from, plus free entry for a level.
 *              Swing: not a field at all; the exit reason is what it records.
 *   Setup    — Minimal: one free text box for every trade.
 *              Intraday: a list per strategy, so each has its own vocabulary.
 *              Swing: one list, because there is only one strategy.
 */

import { customField } from './config.js'

/**
 * Ids are stable and hand-written rather than generated.
 *
 * A preset is data that ships with the build, so its field ids are the same for
 * every buyer who applies it. That is what makes a preset upgradeable: adding a
 * field to "Intraday futures" in a later version lands beside the buyer's
 * existing answers instead of orphaning them under a fresh random id.
 */
const field = (id, label, rest = {}) => customField({ id, label, ...rest })

/**
 * Almost nothing: one strategy, three free-text boxes.
 *
 * Everything is text, which means none of it constrains what you can write and
 * none of it groups cleanly in the stats — a hundred trades produce a hundred
 * setups. That is the honest trade-off of starting free-form, and the reason to
 * turn a box into a list once you can see what you keep typing.
 */
export const MINIMAL_PRESET = {
  id: 'minimal',
  name: 'Minimal',
  summary: 'One strategy, three free-text boxes. Nothing to decide up front.',
  detail:
    'Everything is a text box, so nothing constrains what you write — and nothing groups ' +
    'cleanly in the statistics either. Good for a first month: log freely, see which words ' +
    'you keep typing, then turn those boxes into lists.',
  config: {
    instrument: null,
    session: null,
    strategies: [{ id: 'model_a', label: 'My strategy' }],
    custom_fields: [
      field('p_min_setup', 'Setup', { type: 'text' }),
      field('p_min_target', 'Target', { type: 'text' }),
      field('p_min_mistake', 'Mistake', { type: 'text' }),
    ],
  },
}

const DELAY_BUCKETS = [
  { label: '≤10s', max: 10 },
  { label: '10–30s', max: 30 },
  { label: '30s+', max: null },
]

/**
 * Intraday futures — fast, repeatable, two strategies with separate vocabulary.
 *
 * The setup lists are two *separate fields*, each scoped to its own strategy,
 * rather than one field whose options change. That is what lets the statistics
 * report each strategy's setups on its own terms without the app needing a
 * concept of a setup at all.
 */
export const INTRADAY_FUTURES_PRESET = {
  id: 'intraday-futures',
  name: 'Intraday futures',
  summary: 'Two strategies with their own setup lists, price levels, execution tags.',
  detail:
    'Built for a lot of trades and a short holding period, so it records execution: how long ' +
    'you waited, where the stop sat, which target you were playing for. Entry delay is bucketed ' +
    '(≤10s / 10–30s / 30s+) — an unbucketed number would give one row per distinct value.',
  config: {
    instrument: 'MNQ',
    session: '09:30–12:00 ET',
    strategies: [
      { id: 'model_a', label: 'Strategy A' },
      { id: 'model_b', label: 'Strategy B' },
    ],
    custom_fields: [
      field('p_if_tags', 'Tags', {
        type: 'multiselect',
        options: ['A+', 'Trend', 'Counter-trend', 'News', 'Low volume', 'Revenge'],
      }),
      // Free entry on purpose: a target is a level, and the interesting ones
      // are never on a list you wrote in advance.
      field('p_if_target', 'Target', {
        type: 'multiselect',
        allow_custom: true,
        options: ['VWAP', 'Prior day high', 'Prior day low', 'Overnight high', 'Overnight low'],
      }),
      field('p_if_entry', 'Entry price', { type: 'number' }),
      field('p_if_stop', 'Planned stop', { type: 'number' }),
      field('p_if_exit', 'Actual exit', { type: 'number' }),
      field('p_if_delay', 'Entry delay (s)', { type: 'number', buckets: DELAY_BUCKETS }),
      field('p_if_conviction', 'Conviction', {
        type: 'select',
        options: ['Low', 'Medium', 'High'],
      }),
      field('p_if_veto', 'Would have been', {
        type: 'select',
        options: ['Win', 'Loss', 'Breakeven', 'Unclear'],
      }),
      // Scoped: each strategy offers only its own setups.
      field('p_if_setup_a', 'Setup', {
        type: 'select',
        strategy: 'model_a',
        options: ['Opening drive', 'Failed auction', 'Trend continuation', 'Reversal'],
      }),
      field('p_if_setup_b', 'Setup', {
        type: 'select',
        strategy: 'model_b',
        options: ['Range fade', 'Liquidity sweep', 'VWAP reclaim'],
      }),
    ],
  },
}

/**
 * Swing trading — few entries, long holds, so what pays is recording the thesis
 * and how the position was managed rather than how fast the entry was.
 *
 * One strategy, which means the form shows its name and offers no switch.
 */
export const SWING_PRESET = {
  id: 'swing',
  name: 'Swing',
  summary: 'One strategy, thesis-led fields, holding period and management.',
  detail:
    'For positions held days to weeks. There is no target field — by the time a swing closes, ' +
    'why you got out says more than where you were aiming — so it records an exit reason ' +
    'instead. Days held is bucketed, so "do my winners need more time?" is answerable.',
  config: {
    instrument: null,
    session: null,
    strategies: [{ id: 'model_a', label: 'Core' }],
    custom_fields: [
      field('p_sw_symbol', 'Symbol', { type: 'text' }),
      field('p_sw_thesis_type', 'Thesis type', {
        type: 'select',
        options: ['Breakout', 'Pullback', 'Mean reversion', 'Catalyst', 'Macro'],
      }),
      field('p_sw_timeframe', 'Timeframe', {
        type: 'select',
        options: ['Daily', '4H', 'Weekly'],
      }),
      field('p_sw_hold_days', 'Days held', {
        type: 'number',
        buckets: [
          { label: '≤1d', max: 1 },
          { label: '1–5d', max: 5 },
          { label: '5–20d', max: 20 },
          { label: '20d+', max: null },
        ],
      }),
      field('p_sw_entry', 'Entry price', { type: 'number' }),
      field('p_sw_stop', 'Planned stop', { type: 'number' }),
      field('p_sw_exit', 'Actual exit', { type: 'number' }),
      field('p_sw_exit_reason', 'Exit reason', {
        type: 'select',
        allow_custom: true,
        options: ['Target hit', 'Stopped out', 'Thesis broke', 'Time stop', 'Took profit early'],
      }),
      field('p_sw_scaled', 'Scaled out', { type: 'toggle' }),
      field('p_sw_tags', 'Tags', {
        type: 'multiselect',
        options: ['Earnings', 'Sector strength', 'Against trend', 'Oversized', 'Held too long'],
      }),
    ],
  },
}

export const PRESETS = [MINIMAL_PRESET, INTRADAY_FUTURES_PRESET, SWING_PRESET]

export const findPreset = (id) => PRESETS.find((p) => p.id === id) ?? null
