import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeStatistics } from './compute.js'
import { customField, migrate } from '../domain/config.js'

const trade = (over = {}) => ({
  num: 1,
  date: '2026-07-01T09:30',
  direction: 'Long',
  custom: {},
  status: 'TP',
  pnl: 100,
  rr: 2,
  ...over,
})

test('empty input produces zeros and nulls, never NaN', () => {
  const s = computeStatistics([])
  assert.deepEqual(s.totals, { total: 0, wins: 0, losses: 0, breakeven: 0 })
  assert.equal(s.extremes.best, null)
  assert.equal(s.extremes.worst, null)
  assert.equal(s.averages.avgWinner, null)
  assert.equal(s.averages.profitFactor, null)
  assert.deepEqual(s.curve, [])
  assert.deepEqual(s.byStatus, [])
})

test('computeStatistics tolerates being called with no argument', () => {
  assert.equal(computeStatistics().totals.total, 0)
})

test('counts winners, losers and breakeven', () => {
  const s = computeStatistics([
    trade({ pnl: 100 }),
    trade({ pnl: -50 }),
    trade({ pnl: 0, status: 'BE' }),
  ])
  assert.deepEqual(s.totals, { total: 3, wins: 1, losses: 1, breakeven: 1 })
})

test('an open trade at zero is not breakeven', () => {
  const s = computeStatistics([trade({ pnl: 0, status: 'Open' })])
  assert.equal(s.totals.breakeven, 0)
})

test('best and worst come from the pnl extremes', () => {
  const s = computeStatistics([trade({ pnl: 380 }), trade({ pnl: -129 }), trade({ pnl: 20 })])
  assert.equal(s.extremes.best, 380)
  assert.equal(s.extremes.worst, -129)
})

test('avg winner and avg loser average only their own side', () => {
  const s = computeStatistics([trade({ pnl: 100 }), trade({ pnl: 200 }), trade({ pnl: -60 })])
  assert.equal(s.averages.avgWinner, 150)
  assert.equal(s.averages.avgLoser, -60)
})

test('profit factor is gross win over gross loss', () => {
  const s = computeStatistics([trade({ pnl: 300 }), trade({ pnl: -100 }), trade({ pnl: -100 })])
  assert.equal(s.averages.profitFactor, 1.5)
})

test('profit factor is null with no losses, rather than Infinity', () => {
  const s = computeStatistics([trade({ pnl: 100 })])
  assert.equal(s.averages.profitFactor, null)
})

test('avg R is realised — P&L over risk — and skips trades with no risk', () => {
  const s = computeStatistics([
    trade({ pnl: 100, risk: 50 }), // +2R
    trade({ pnl: 200, risk: 50 }), // +4R
    trade({ pnl: 400, risk: 0 }), // no declared risk: no R at all
  ])
  assert.equal(s.averages.avgR, 3, 'averaged over 2, not 3')
})

test('avg R is null when no trade declared a risk', () => {
  assert.equal(computeStatistics([trade({ risk: 0 })]).averages.avgR, null)
})

test('a user-defined field becomes its own breakdown', () => {
  const config = migrate({
    custom_fields: [
      customField({ id: 'f_setup', label: 'Setup', type: 'select', options: ['A', 'B'] }),
    ],
  })

  const s = computeStatistics(
    [
      trade({ pnl: 100, custom: { f_setup: 'A' } }),
      trade({ pnl: -50, custom: { f_setup: 'A' } }),
      trade({ pnl: 200, custom: { f_setup: 'B' } }),
    ],
    config
  )

  const setup = s.byField.find((f) => f.id === 'f_setup')
  assert.equal(setup.label, 'Setup')
  assert.deepEqual(setup.rows, [
    { label: 'A', count: 2, winRate: 50, pnl: 50 },
    { label: 'B', count: 1, winRate: 100, pnl: 200 },
  ])
})

test('a value the trader removed from a field keeps its history', () => {
  const config = migrate({
    custom_fields: [
      customField({ id: 'f_setup', label: 'Setup', type: 'select', options: ['A'] }),
    ],
  })

  const s = computeStatistics([trade({ pnl: 100, custom: { f_setup: 'Retired' } })], config)
  const setup = s.byField.find((f) => f.id === 'f_setup')

  assert.deepEqual(
    setup.rows.map((r) => r.label),
    ['Retired'],
    'a trade counted in the totals must be visible in some row'
  )
})

test('a multi-value field is flagged, because its rows over-count', () => {
  const config = migrate({
    custom_fields: [
      customField({ id: 'f_tags', label: 'Tags', type: 'multiselect', options: ['x', 'y'] }),
    ],
  })

  const s = computeStatistics([trade({ pnl: 100, custom: { f_tags: ['x', 'y'] } })], config)
  const tags = s.byField.find((f) => f.id === 'f_tags')

  assert.equal(tags.multi, true)
  assert.deepEqual(tags.rows.map((r) => r.count), [1, 1], 'one trade, two rows')
})

test('an unbucketed number field gets no panel', () => {
  const config = migrate({
    custom_fields: [customField({ id: 'f_entry', label: 'Entry', type: 'number' })],
  })

  const s = computeStatistics([trade({ custom: { f_entry: 19875.5 } })], config)
  assert.equal(s.byField.length, 0)
})

test('with no config the page still renders every column-backed block', () => {
  const s = computeStatistics([trade({ pnl: 100 })])
  assert.deepEqual(s.byField, [])
  assert.equal(s.totals.total, 1)
})

test('the curve runs oldest first and accumulates', () => {
  const s = computeStatistics([
    trade({ num: 2, date: '2026-07-02T09:30', pnl: -30 }),
    trade({ num: 1, date: '2026-07-01T09:30', pnl: 100 }),
    trade({ num: 3, date: '2026-07-03T09:30', pnl: 50 }),
  ])
  assert.deepEqual(s.curve.map((p) => p.num), [1, 2, 3])
  assert.deepEqual(s.curve.map((p) => p.cumulative), [100, 70, 120])
})

test('the curve can go and stay negative', () => {
  const s = computeStatistics([
    trade({ num: 1, date: '2026-07-01T09:30', pnl: -100 }),
    trade({ num: 2, date: '2026-07-02T09:30', pnl: -20 }),
  ])
  assert.deepEqual(s.curve.map((p) => p.cumulative), [-100, -120])
})

test('by direction reports count, win rate and pnl', () => {
  const s = computeStatistics([
    trade({ direction: 'Long', pnl: 100 }),
    trade({ direction: 'Long', pnl: -50 }),
    trade({ direction: 'Short', pnl: 200 }),
  ])
  assert.deepEqual(s.byDirection, [
    { label: 'Long', count: 2, winRate: 50, pnl: 50 },
    { label: 'Short', count: 1, winRate: 100, pnl: 200 },
  ])
})

test('a direction with no trades reports a null win rate, not 0%', () => {
  const s = computeStatistics([trade({ direction: 'Long' })])
  assert.equal(s.byDirection.find((d) => d.label === 'Short').winRate, null)
})

test('by status lists only statuses present, in the known order', () => {
  const s = computeStatistics([
    trade({ status: 'BE', pnl: 0 }),
    trade({ status: 'TP', pnl: 100 }),
    trade({ status: 'SL', pnl: -40 }),
  ])
  assert.deepEqual(s.byStatus.map((r) => r.label), ['TP', 'SL', 'BE'])
})

test('an unrecognised status still appears, after the known ones', () => {
  const s = computeStatistics([trade({ status: 'TP' }), trade({ status: 'Scratch' })])
  assert.deepEqual(s.byStatus.map((r) => r.label), ['TP', 'Scratch'])
})

test('string numerics from Postgres are coerced before arithmetic', () => {
  const s = computeStatistics([trade({ pnl: '100' }), trade({ pnl: '-40' })])
  assert.equal(s.totals.wins, 1)
  assert.equal(s.totals.losses, 1)
  assert.equal(s.curve.at(-1).cumulative, 60)
})

test('null pnl counts as zero rather than poisoning the curve', () => {
  const s = computeStatistics([trade({ pnl: null, status: 'Open' }), trade({ pnl: 50 })])
  assert.equal(s.curve.at(-1).cumulative, 50)
})
