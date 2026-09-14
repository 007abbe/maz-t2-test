import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregate,
  bucketOf,
  computeTradeStats,
  groupBy,
  groupByCustom,
  groupByEach,
  rMultiple,
  EARLY_SIGNAL_MAX,
  MIN_SAMPLE,
} from './trade-stats.js'
import { fromRow } from '../journal/mapping.js'
import { customField, migrate } from './config.js'

/** Field ids are opaque in production; fixed here so assertions can name them. */
const SETUP = 'f_setup'
const TAGS = 'f_tags'
const DELAY = 'f_delay'

const DELAY_BUCKETS = [
  { label: '0-10s', max: 10 },
  { label: '10-30s', max: 30 },
  { label: '30s+', max: null },
]

const config = migrate({
  custom_fields: [
    customField({ id: SETUP, label: 'Setup', type: 'select', options: ['Opening range'] }),
    customField({ id: TAGS, label: 'Tags', type: 'multiselect', options: ['with-trend'] }),
    customField({ id: DELAY, label: 'Entry delay', type: 'number', buckets: DELAY_BUCKETS }),
  ],
})

let seq = 0

/** A mapped trade, as `fromRow` produces one. */
const trade = (overrides = {}) => ({
  id: `t${++seq}`,
  num: seq,
  date: `2026-07-${String(10 + (seq % 20)).padStart(2, '0')}T15:30`,
  pnl: 100,
  risk: 50,
  direction: 'Long',
  status: 'TP',
  strategy: 'model_a',
  custom: { [SETUP]: 'Opening range', [TAGS]: ['with-trend'] },
  ...overrides,
})

/** A trade answering exactly the custom fields given, and nothing else. */
const tagged = (custom, overrides = {}) => trade({ custom, ...overrides })

/** `n` trades that trip no thresholds, for padding a group to a given size. */
const filler = (n, overrides = {}) =>
  Array.from({ length: n }, () => trade(overrides))

// --- rMultiple ------------------------------------------------------------

test('rMultiple is P&L over declared risk', () => {
  assert.equal(rMultiple(trade({ pnl: 100, risk: 50 })), 2)
  assert.equal(rMultiple(trade({ pnl: -75, risk: 50 })), -1.5)
  assert.equal(rMultiple(trade({ pnl: 0, risk: 50 })), 0)
})

test('rMultiple is null without usable risk, never Infinity', () => {
  assert.equal(rMultiple(trade({ pnl: 100, risk: 0 })), null)
  assert.equal(rMultiple(trade({ pnl: 100, risk: -50 })), null)
})

// --- aggregate ------------------------------------------------------------

test('an empty group reports nulls, not zeroes', () => {
  const stats = aggregate([])

  assert.equal(stats.n, 0)
  assert.equal(stats.winRate, null, '0% would claim a measured 0% win rate')
  assert.equal(stats.avgR, null)
  assert.equal(stats.totalR, null)
  assert.equal(stats.insufficient, true)
})

test('breakeven is anything that is neither a win nor a loss', () => {
  const stats = aggregate([
    trade({ pnl: 100 }),
    trade({ pnl: -50 }),
    trade({ pnl: 0 }),
  ])

  assert.equal(stats.wins, 1)
  assert.equal(stats.losses, 1)
  assert.equal(stats.be, 1)
  assert.equal(stats.n, 3)
})

test('win rate is a percentage to one decimal', () => {
  const stats = aggregate([
    trade({ pnl: 100 }),
    trade({ pnl: 100 }),
    trade({ pnl: -50 }),
  ])
  assert.equal(stats.winRate, 66.7)
})

test('R figures average over the trades that have R, and say so', () => {
  const stats = aggregate([
    trade({ pnl: 100, risk: 50 }), // +2R
    trade({ pnl: -50, risk: 50 }), // -1R
    trade({ pnl: 400, risk: 0 }), // no declared risk — excluded from R
  ])

  assert.equal(stats.n, 3)
  assert.equal(stats.rSample, 2, 'the R denominator differs from n')
  assert.equal(stats.totalR, 1)
  assert.equal(stats.avgR, 0.5, 'averaged over 2, not 3')
})

test('R figures round to two decimals', () => {
  const stats = aggregate([
    trade({ pnl: 100, risk: 30 }),
    trade({ pnl: 100, risk: 30 }),
    trade({ pnl: 100, risk: 30 }),
  ])
  assert.equal(stats.avgR, 3.33)
  assert.equal(stats.totalR, 10)
})

test('sample-size flags are carried as data, at the documented boundaries', () => {
  const flags = (n) => {
    const { insufficient, earlySignal } = aggregate(filler(n))
    return { insufficient, earlySignal }
  }

  assert.deepEqual(flags(MIN_SAMPLE - 1), { insufficient: true, earlySignal: false })
  assert.deepEqual(flags(MIN_SAMPLE), { insufficient: false, earlySignal: true })
  assert.deepEqual(flags(EARLY_SIGNAL_MAX), { insufficient: false, earlySignal: true })
  assert.deepEqual(flags(EARLY_SIGNAL_MAX + 1), { insufficient: false, earlySignal: false })
})

// --- groupBy --------------------------------------------------------------

test('groupBy aggregates each key independently', () => {
  const groups = groupBy(
    [
      tagged({ [SETUP]: 'Opening range' }, { pnl: 100 }),
      tagged({ [SETUP]: 'Opening range' }, { pnl: 100 }),
      tagged({ [SETUP]: 'Failed breakout' }, { pnl: -50 }),
    ],
    (t) => t.custom[SETUP]
  )

  assert.equal(groups['Opening range'].n, 2)
  assert.equal(groups['Opening range'].winRate, 100)
  assert.equal(groups['Failed breakout'].n, 1)
  assert.equal(groups['Failed breakout'].winRate, 0)
})

test('an absent tag groups under untagged rather than vanishing', () => {
  const groups = groupBy(
    [tagged({}), tagged({ [SETUP]: undefined }), tagged({ [SETUP]: 'Opening range' })],
    (t) => t.custom[SETUP]
  )

  assert.equal(groups.untagged.n, 2)
  assert.equal(groups['Opening range'].n, 1)
})

test('a falsy-but-real key is not mistaken for untagged', () => {
  const groups = groupBy([trade()], (t) => (t.pnl > 1000 ? 'big' : 'ordinary'))

  assert.deepEqual(Object.keys(groups), ['ordinary'])
})

// --- computeTradeStats ----------------------------------------------------

test('afterTwoLosses picks up every trade following two consecutive losses', () => {
  // L L W L L L W  ->  the 3rd trade, plus the 6th and 7th
  const pnls = [-50, -50, 100, -50, -50, -50, 100]
  const trades = pnls.map((pnl, i) => trade({ pnl, date: `2026-07-0${i + 1}T15:30` }))

  assert.equal(computeTradeStats(trades).afterTwoLosses.n, 3)
})

test('afterTwoLosses is chronological regardless of input order', () => {
  const chronological = [-50, -50, 100].map((pnl, i) =>
    trade({ pnl, date: `2026-07-0${i + 1}T15:30` })
  )
  const shuffled = [chronological[2], chronological[0], chronological[1]]

  assert.equal(computeTradeStats(shuffled).afterTwoLosses.n, 1)
  assert.deepEqual(
    computeTradeStats(shuffled).afterTwoLosses,
    computeTradeStats(chronological).afterTwoLosses
  )
})

test('a breakeven between two losses breaks the sequence', () => {
  const pnls = [-50, 0, -50, 100]
  const trades = pnls.map((pnl, i) => trade({ pnl, date: `2026-07-0${i + 1}T15:30` }))

  assert.equal(computeTradeStats(trades).afterTwoLosses.n, 0)
})

test('a multi-value field counts a trade in every value it carries', () => {
  const stats = computeTradeStats(
    [
      tagged({ [TAGS]: ['a', 'b'] }, { pnl: -50, risk: 50 }),
      tagged({ [TAGS]: ['a'] }, { pnl: -100, risk: 50 }),
      tagged({ [TAGS]: [] }, { pnl: 100, risk: 50 }),
    ],
    config
  )

  assert.equal(stats.byCustom[TAGS].a.n, 2)
  assert.equal(stats.byCustom[TAGS].a.totalR, -3)
  assert.equal(stats.byCustom[TAGS].b.n, 1)
  assert.equal(stats.byCustom[TAGS].untagged.n, 1, 'an empty list is untagged, not absent')
})

test('a tagged trade with no declared risk still counts, without skewing R', () => {
  const stats = computeTradeStats(
    [
      tagged({ [TAGS]: ['a'] }, { pnl: -50, risk: 0 }),
      tagged({ [TAGS]: ['a'] }, { pnl: -50, risk: 50 }),
    ],
    config
  )

  assert.equal(stats.byCustom[TAGS].a.n, 2)
  assert.equal(stats.byCustom[TAGS].a.rSample, 1)
  assert.equal(stats.byCustom[TAGS].a.totalR, -1)
})

test('a bucketed number field splits at its documented boundaries', () => {
  const stats = computeTradeStats(
    [0, 10, 11, 30, 31].map((v) => tagged({ [DELAY]: v })).concat(tagged({})),
    config
  )

  assert.equal(stats.byCustom[DELAY]['0-10s'].n, 2)
  assert.equal(stats.byCustom[DELAY]['10-30s'].n, 2)
  assert.equal(stats.byCustom[DELAY]['30s+'].n, 1)
  assert.ok(
    !('untagged' in stats.byCustom[DELAY]),
    'unanswered trades are excluded, not bucketed as untagged'
  )
})

test('an unbucketed number field is recorded but never grouped', () => {
  const price = migrate({
    custom_fields: [customField({ id: 'f_price', label: 'Entry', type: 'number' })],
  })

  const stats = computeTradeStats(
    [19875.5, 19876.25, 19877].map((v) => tagged({ f_price: v })),
    price
  )

  assert.ok(
    !('f_price' in stats.byCustom),
    'one bucket per distinct price is noise, not a breakdown'
  )
})

test('bucketOf leaves a value past every closed bound unbucketed', () => {
  const closed = customField({
    id: 'f_x',
    label: 'X',
    type: 'number',
    buckets: [{ label: 'small', max: 10 }],
  })

  assert.equal(bucketOf(closed, 5), 'small')
  assert.equal(bucketOf(closed, 50), null, 'inventing a home for it would misreport the group')
  assert.equal(bucketOf(closed, 'not a number'), null)
})

test('a field deleted from config still reports the history it collected', () => {
  const stats = computeTradeStats(
    [tagged({ f_gone: 'yes' }), tagged({ f_gone: 'yes' }), tagged({ f_gone: 'no' })],
    config
  )

  assert.equal(stats.byCustom.f_gone.yes.n, 2)
  assert.equal(stats.byCustom.f_gone.no.n, 1)
})

test('groupByCustom falls back to grouping by raw value with no config', () => {
  const groups = groupByCustom([tagged({ [SETUP]: 'A' }), tagged({ [SETUP]: 'B' })])

  assert.equal(groups[SETUP].A.n, 1)
  assert.equal(groups[SETUP].B.n, 1)
})

test('untagged counts trades with no strategy', () => {
  const stats = computeTradeStats(
    [trade({ strategy: null }), trade({ strategy: 'model_a' })],
    config
  )

  assert.equal(stats.untaggedCount, 1)
})

test('direction and status are broken out from their own columns', () => {
  const stats = computeTradeStats(
    [
      trade({ direction: 'Long', status: 'TP' }),
      trade({ direction: 'Short', status: 'SL', pnl: -50 }),
      trade({ direction: 'Long', status: 'TP' }),
    ],
    config
  )

  assert.equal(stats.byDirection.Long.n, 2)
  assert.equal(stats.byDirection.Short.n, 1)
  assert.equal(stats.byStatus.TP.n, 2)
  assert.equal(stats.byStatus.SL.n, 1)
})

test('the thresholds travel with the stats', () => {
  const stats = computeTradeStats(filler(3))

  assert.deepEqual(stats.thresholds, {
    minSample: MIN_SAMPLE,
    earlySignalMax: EARLY_SIGNAL_MAX,
  })
  assert.equal(
    stats.overall.insufficient,
    true,
    'a 3-trade selection is not reportable'
  )
})

test('an empty selection produces a complete, empty stats object', () => {
  const stats = computeTradeStats([])

  assert.equal(stats.overall.n, 0)
  assert.deepEqual(stats.byStrategy, {})
  assert.deepEqual(stats.byCustom, {})
  assert.equal(stats.untaggedCount, 0)
})

// --- integration with the row mapping -------------------------------------

test('stats are correct on rows mapped from Postgres string numerics', () => {
  const row = (overrides) =>
    fromRow({
      id: 'a1',
      num: 1,
      date: '2026-07-24T15:30',
      pnl: '412.50', // Postgres numerics arrive as strings
      risk: '150',
      direction: 'Long',
      custom: { [SETUP]: 'Failed breakout', [DELAY]: 12 },
      ...overrides,
    })

  const stats = computeTradeStats(
    [row({}), row({ id: 'a2', pnl: '-150', risk: '150' })],
    config
  )

  assert.equal(stats.overall.wins, 1, 'string P&L must not compare as text')
  assert.equal(stats.overall.losses, 1)
  assert.equal(stats.overall.totalR, 1.75)
  assert.equal(stats.overall.avgR, 0.88)
  assert.equal(stats.byCustom[DELAY]['10-30s'].n, 2)
  assert.equal(stats.byCustom[SETUP]['Failed breakout'].n, 2)
})

test('groupByEach counts a trade in every tag it carries', () => {
  const both = tagged({ [TAGS]: ['with-trend', 'news-day'] })
  const one = tagged({ [TAGS]: ['news-day'] })

  const groups = groupByEach([both, one], (t) => t.custom[TAGS])

  // Overlapping on purpose: 2 trades, 3 memberships.
  assert.equal(groups['with-trend'].n, 1)
  assert.equal(groups['news-day'].n, 2)
})

test('groupByEach buckets an empty tag list as untagged', () => {
  const groups = groupByEach([tagged({ [TAGS]: [] })], (t) => t.custom[TAGS])
  assert.equal(groups.untagged.n, 1)
})

test('groupByEach does not iterate a stray scalar character by character', () => {
  const groups = groupByEach([tagged({ [TAGS]: 'VWAP' })], (t) => t.custom[TAGS])
  assert.deepEqual(Object.keys(groups), ['untagged'])
})
