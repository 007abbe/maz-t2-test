import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  toRow, fromRow, stampNow, uid, toDatetimeLocal, isValidTradeDate,
} from './mapping.js'
import { DEFAULT_STATUSES, DIRECTIONS } from '../domain/trade-vocab.js'

const USER = '00000000-0000-0000-0000-000000000001'

/** A row shaped exactly as Postgres returns it: numerics as strings. */
const dbRow = {
  id: 'mdq1x2ab',
  user_id: USER,
  num: 42,
  date: '2026-07-24T14:30',
  direction: 'Long',
  status: 'TP1+BE',
  pnl: '412.50',
  risk: '150',
  kind: 'trade',
  account_id: '00000000-0000-0000-0000-0000000000ac',
  strategy: 'model_a',
  thesis: 'Held the open range and took the retest',
  hindsight: 'Held too long',
  image: 'data:image/jpeg;base64,/9j/4AAQ',
  // The trader's own vocabulary, keyed by generated field id (§4.2): a setup,
  // a tag list, a price and a bucketed number all live here.
  custom: {
    cf_7x2k: 'Opening range',
    cf_9m3p: ['with-trend'],
    cf_p4rz: 19850.25,
    cf_d3ly: 12,
  },
  archived: false,
  updated_at: 1753363800000,
}

test('fromRow -> toRow round-trips every column', () => {
  const roundTripped = toRow(fromRow(dbRow), USER)

  // Numerics come back as JS numbers, which is the same value Postgres stores.
  assert.deepEqual(roundTripped, { ...dbRow, pnl: 412.5, risk: 150 })
})

test('a null kind survives as null — pre-veto rows are not rewritten', () => {
  // Readers resolve null to 'trade' themselves (tradeKind). Stamping 'trade'
  // here would rewrite history on the first edit of an old trade.
  assert.equal(toRow(fromRow({ id: 'x', updated_at: 1 }), USER).kind, null)
})

test('the schema is seventeen columns, and this is the list', () => {
  // The count is the point, not an implementation detail. Every column here
  // earns its place by being something the app computes with generically
  // (ARCHITECTURE.md, rule 1); anything describing *how* the trader trades belongs in
  // `custom`. A new column appearing in this list is a migration for every
  // buyer, so it should be hard to add by accident — `archived` earned one
  // because the list query filters on it in SQL.
  const COLUMNS = [
    'id', 'user_id', 'updated_at',
    'num', 'date', 'direction', 'status',
    'pnl', 'risk',
    'kind', 'account_id', 'strategy',
    'thesis', 'hindsight', 'image',
    'custom', 'archived',
  ]

  assert.equal(COLUMNS.length, 17)
  assert.deepEqual(Object.keys(toRow(fromRow(dbRow), USER)).sort(), [...COLUMNS].sort())
})

test('a missing account_id means unassigned, never an empty string', () => {
  // The column is a uuid: '' would be rejected by Postgres, null is the value
  // every trade logged before accounts existed carries.
  assert.equal(toRow(fromRow({ id: 'x', updated_at: 1 }), USER).account_id, null)
  assert.equal(toRow({ id: 'x', updatedAt: 1, account_id: '' }, USER).account_id, null)
})

test('an empty row survives the round-trip with the documented defaults', () => {
  const empty = toRow(fromRow({ id: 'x', updated_at: 1 }), USER)
  assert.equal(empty.pnl, 0)
  assert.equal(empty.risk, 0)
  assert.deepEqual(empty.custom, {}, 'custom must never be null')
  assert.equal(empty.strategy, null)
  assert.equal(empty.kind, null)
  assert.equal(empty.archived, false, 'a trade is in the working list until archived')
})

test('null text fields normalise to empty string, not back to null', () => {
  // fromRow does `r.thesis || ''`, and toRow's `?? null` does not catch ''.
  // So a NULL thesis in the DB is rewritten as '' the first time a trade is
  // saved. Deliberate: '' and NULL read identically everywhere else.
  const row = toRow(fromRow({ id: 'x', thesis: null, hindsight: null, updated_at: 1 }), USER)
  assert.equal(row.thesis, '')
  assert.equal(row.hindsight, '')
})

test('updated_at stays epoch milliseconds through the round-trip', () => {
  assert.equal(toRow(fromRow(dbRow), USER).updated_at, 1753363800000)
  assert.equal(typeof toRow(fromRow(dbRow), USER).updated_at, 'number')
})

test('toRow refuses anything that is not epoch milliseconds', () => {
  // The data-loss guard: each of these collapses to 0 in a
  // `Number(r.updated_at) || 0` merge, making it treat cloud rows as stale.
  for (const bad of [
    new Date(1753363800000),
    '2026-07-24T14:30:00Z',
    '1753363800000',
    1753363800000.5,
    0,
    -1,
    NaN,
  ]) {
    assert.throws(
      () => toRow({ id: 'x', updatedAt: bad }, USER),
      TypeError,
      `should reject updatedAt=${String(bad)}`
    )
  }
})

test('absent updated_at defaults to now; null and undefined mean the same', () => {
  for (const t of [{ id: 'x' }, { id: 'x', updatedAt: null }, { id: 'x', updatedAt: undefined }]) {
    const before = Date.now()
    const { updated_at } = toRow(t, USER)
    assert.ok(Number.isInteger(updated_at) && updated_at >= before)
  }
})

test('toRow requires a user id', () => {
  assert.throws(() => toRow({ id: 'x', updatedAt: 1 }), /user id/)
})

test('stampNow refreshes updatedAt on a trade read back from the DB', () => {
  // The edit-loses-the-write bug: without stampNow, saving a trade that was
  // read via fromRow writes back its stored timestamp, so the merge
  // sees no change and can clobber the edit with its stale local copy.
  const stored = fromRow(dbRow)
  assert.equal(stored.updatedAt, 1753363800000)

  const before = Date.now()
  const saved = toRow(stampNow(stored), USER)
  assert.ok(saved.updated_at >= before, 'stamp must be current, not the stored value')
  assert.notEqual(saved.updated_at, 1753363800000)
})

test('stampNow does not mutate its input', () => {
  const stored = fromRow(dbRow)
  stampNow(stored)
  assert.equal(stored.updatedAt, 1753363800000)
})

test('uid does not collide, even minting in a tight loop', () => {
  // `id` is the upsert conflict key, so a collision overwrites a real trade.
  // A 4-char random suffix fails this at ~4 per 10k.
  const N = 200000
  const ids = new Set(Array.from({ length: N }, uid))
  assert.equal(ids.size, N, 'ids must not collide')
})

test('uid stays a plain lowercase alphanumeric string', () => {
  for (const id of Array.from({ length: 100 }, uid)) {
    assert.match(id, /^[a-z0-9]+$/, 'text column and URL-safe: no dashes, no padding')
  }
})

test('uid sorts by creation across milliseconds', async () => {
  // Only across milliseconds: ids minted inside one millisecond share the
  // timestamp prefix, so the random suffix decides their relative order.
  const a = uid()
  await new Promise((r) => setTimeout(r, 2))
  const b = uid()
  assert.ok(a < b, `${a} should sort before ${b}`)
  assert.equal(a.length, b.length, 'fixed width, so lexicographic order is stable')
})

test('a new trade round-trips through the full write shape', () => {
  const created = toRow(
    stampNow({ id: uid(), num: 1, date: '2026-07-28T09:15', direction: 'Short' }),
    USER
  )
  assert.equal(created.user_id, USER)
  assert.equal(created.pnl, 0)
  assert.deepEqual(created.custom, {})
  assert.ok(Number.isInteger(created.updated_at))
})

test('toDatetimeLocal emits the exact shape the date column expects', () => {
  assert.equal(toDatetimeLocal(new Date(2026, 0, 5, 9, 7)), '2026-01-05T09:07')
  assert.equal(toDatetimeLocal(new Date(2026, 11, 31, 23, 59)), '2026-12-31T23:59')
  assert.match(toDatetimeLocal(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
})

test('toDatetimeLocal output sorts lexicographically in chronological order', () => {
  // `date` is a text column and listTrades orders on it, so string order has to
  // match time order — that is the whole reason for the zero padding.
  const dates = [
    new Date(2026, 0, 5, 9, 7),
    new Date(2026, 0, 5, 10, 0),
    new Date(2026, 9, 1, 0, 0),
    new Date(2027, 0, 1, 0, 0),
  ].map(toDatetimeLocal)
  assert.deepEqual([...dates].sort(), dates)
})

test('isValidTradeDate accepts the column format and rejects the rest', () => {
  assert.ok(isValidTradeDate('2026-07-24T14:30'))
  assert.ok(isValidTradeDate('2026-07-24T14:30:00'))
  for (const bad of ['', '2026-07-24', '24/07/2026 14:30', 'yesterday', null, undefined, 12345]) {
    assert.ok(!isValidTradeDate(bad), `should reject ${JSON.stringify(bad)}`)
  }
})

test('a second strategy round-trips with its own field answers', () => {
  const other = {
    ...dbRow,
    strategy: 'model_b',
    custom: { cf_b1: 'Failed breakout', cf_b2: 19875.5 },
  }
  const t = fromRow(other)

  assert.equal(t.strategy, 'model_b')
  assert.deepEqual(t.custom, { cf_b1: 'Failed breakout', cf_b2: 19875.5 })

  const back = toRow(t, USER)
  assert.equal(back.strategy, 'model_b')
  assert.deepEqual(back.custom, { cf_b1: 'Failed breakout', cf_b2: 19875.5 })
})

test('an untagged row keeps a null strategy rather than inventing one', () => {
  // A journal with no strategies configured logs every trade like this, and so
  // does every trade logged before the trader defined one. Neither is an error.
  const untagged = fromRow({ id: 'x', updated_at: 1 })

  assert.equal(untagged.strategy, null)
  assert.deepEqual(untagged.custom, {})
  assert.equal(toRow(untagged, USER).strategy, null, 'reading a row must not invent a strategy')
})

test('a renamed strategy leaves stored trades untouched', () => {
  // The whole point of storing the id (§4.2): the label lives in config, so
  // renaming it is not a data change. The same holds for every custom field —
  // the row carries field *ids*, and the answers the trader typed.
  const row = toRow(fromRow(dbRow), USER)

  assert.equal(row.strategy, 'model_a')
  assert.ok(
    Object.keys(row.custom).every((k) => /^cf_/.test(k)),
    'custom is keyed by field id, never by the field label'
  )
})

test('custom fields are keyed by generated id and survive the round-trip', () => {
  // Every shape a field value can take, through the mapping unchanged: text,
  // a multi-select list, a number and a toggle.
  const answers = { cf_7x2k: 'A', cf_9m3p: ['x', 'y'], cf_p4rz: 19850.25, cf_tg1: true }
  const t = fromRow({ ...dbRow, custom: answers })

  assert.deepEqual(t.custom, answers)
  assert.deepEqual(toRow(t, USER).custom, answers)
})

test('a null custom column reads as an empty object, not undefined', () => {
  // Every reader treats "no answer" and "no column" as the same thing, so
  // neither may arrive as undefined and crash a lookup.
  assert.deepEqual(fromRow({ id: 'x', custom: null, updated_at: 1 }).custom, {})
  assert.deepEqual(toRow({ id: 'x', updatedAt: 1 }, USER).custom, {})
})

test('the sample row only uses valid vocabulary values', () => {
  const t = fromRow(dbRow)
  assert.ok(DIRECTIONS.includes(t.direction))
  assert.ok(DEFAULT_STATUSES.includes(t.status))
})

test('the vocabularies that ship are the ones true of any journal', () => {
  // Directions are code because they are structural and closed: a trade is long
  // or short. Statuses ship only as a *default* — every journal records how a
  // trade finished, but "TP / SL / BE" is futures shorthand, so the list is
  // editable from Settings. Everything a *strategy* defines is config, and none
  // of it is asserted here because none of it ships.
  assert.deepEqual(DIRECTIONS, ['Long', 'Short'])
  assert.deepEqual(DEFAULT_STATUSES, ['Open', 'TP', 'SL', 'BE', 'TP1+BE'])
})
