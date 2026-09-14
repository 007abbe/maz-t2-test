import { test } from 'node:test'
import assert from 'node:assert/strict'
import { customField, migrate } from './config.js'
import {
  MAX_STRATEGIES,
  addField,
  addStrategy,
  applyPreset,
  bucketBounds,
  clearConfig,
  completeOnboarding,
  deleteField,
  deleteStrategy,
  fieldsLostWith,
  moveField,
  renameStrategy,
  restartOnboarding,
  setBuckets,
  setCurrency,
  setOptions,
  setStatuses,
  toggleTile,
  updateField,
} from './config-edit.js'
import { DEFAULT_VISIBLE_STATS, visibleTiles } from './header-tiles.js'
import { DEFAULT_STATUSES } from './trade-vocab.js'
import { INTRADAY_FUTURES_PRESET, MINIMAL_PRESET } from './presets.js'

const blank = () => migrate({})

const withFields = (...fields) =>
  migrate({
    strategies: [
      { id: 'model_a', label: 'A' },
      { id: 'model_b', label: 'B' },
    ],
    custom_fields: fields,
  })

// --- nothing mutates ------------------------------------------------------

test('every edit returns a new config and leaves the old one alone', () => {
  const before = withFields(customField({ id: 'f_1', label: 'Setup' }))
  const snapshot = JSON.parse(JSON.stringify(before))

  addStrategy(before, 'C')
  addField(before, { label: 'Mood' })
  deleteField(before, 'f_1')
  moveField(before, 'f_1', 1)

  assert.deepEqual(before, snapshot, 'an editor mutated its input')
})

// --- strategies -----------------------------------------------------------

test('a new strategy takes the next free id, not one derived from its name', () => {
  const one = addStrategy(blank(), 'Opening drive')
  assert.deepEqual(one.strategies, [{ id: 'model_a', label: 'Opening drive' }])

  const two = addStrategy(one, 'Midday reversion')
  assert.deepEqual(two.strategies.map((s) => s.id), ['model_a', 'model_b'])
})

test('a strategy needs a name', () => {
  assert.throws(() => addStrategy(blank(), '   '), /name/i)
})

test('there is a hard ceiling on strategies', () => {
  let config = blank()
  for (let i = 0; i < MAX_STRATEGIES; i++) config = addStrategy(config, `S${i}`)

  assert.equal(config.strategies.length, MAX_STRATEGIES)
  assert.throws(() => addStrategy(config, 'One more'), /maximum/i)
})

test('renaming a strategy never touches its id', () => {
  const renamed = renameStrategy(withFields(), 'model_a', 'Trend continuation')

  assert.equal(renamed.strategies[0].id, 'model_a', 'a rename must not re-key trades')
  assert.equal(renamed.strategies[0].label, 'Trend continuation')
})

test('deleting a strategy takes its scoped fields and leaves the rest', () => {
  const config = withFields(
    customField({ id: 'f_global', label: 'Tags', type: 'multiselect' }),
    customField({ id: 'f_a', label: 'Setup', strategy: 'model_a' }),
    customField({ id: 'f_b', label: 'Setup', strategy: 'model_b' })
  )

  assert.deepEqual(fieldsLostWith(config, 'model_a').map((f) => f.id), ['f_a'])

  const after = deleteStrategy(config, 'model_a')
  assert.deepEqual(after.strategies.map((s) => s.id), ['model_b'])
  assert.deepEqual(after.custom_fields.map((f) => f.id), ['f_global', 'f_b'])
})

// --- fields ---------------------------------------------------------------

test('a new field gets a generated id, never one derived from its label', () => {
  const [field] = addField(blank(), { label: 'Setup' }).custom_fields

  assert.ok(field.id.startsWith('f_'))
  assert.ok(!field.id.includes('etup'), 'a label-derived id would re-key on rename')
})

test('re-adding a field after deleting it produces a different id', () => {
  // The old answers must not silently reattach to a field the trader believes
  // is new — they were collected under a question that no longer exists.
  const added = addField(blank(), { label: 'Setup' })
  const [first] = added.custom_fields
  const again = addField(deleteField(added, first.id), { label: 'Setup' })

  assert.notEqual(again.custom_fields[0].id, first.id)
})

test('updating a field keeps its id whatever else changes', () => {
  const config = withFields(customField({ id: 'f_1', label: 'Setup', type: 'text' }))
  const after = updateField(config, 'f_1', {
    label: 'Entry quality',
    type: 'select',
    strategy: 'model_b',
  })

  assert.deepEqual(after.custom_fields[0], {
    id: 'f_1',
    label: 'Entry quality',
    type: 'select',
    options: [],
    buckets: [],
    allow_custom: false,
    strategy: 'model_b',
  })
})

test('a field cannot be renamed to nothing', () => {
  const config = withFields(customField({ id: 'f_1', label: 'Setup' }))
  assert.throws(() => updateField(config, 'f_1', { label: '  ' }), /name/i)
})

test('fields reorder, and the ends do not wrap around', () => {
  const config = withFields(
    customField({ id: 'f_1', label: 'One' }),
    customField({ id: 'f_2', label: 'Two' }),
    customField({ id: 'f_3', label: 'Three' })
  )
  const ids = (c) => c.custom_fields.map((f) => f.id)

  assert.deepEqual(ids(moveField(config, 'f_3', -1)), ['f_1', 'f_3', 'f_2'])
  assert.deepEqual(ids(moveField(config, 'f_1', -1)), ['f_1', 'f_2', 'f_3'], 'no wrap')
  assert.deepEqual(ids(moveField(config, 'f_3', 1)), ['f_1', 'f_2', 'f_3'], 'no wrap')
})

// --- options --------------------------------------------------------------

test('options come from one line each, trimmed, blanks and repeats dropped', () => {
  const config = withFields(customField({ id: 'f_1', label: 'Setup', type: 'select' }))
  const after = setOptions(config, 'f_1', '  Opening drive \n\n Fade \nOpening drive\n')

  assert.deepEqual(after.custom_fields[0].options, ['Opening drive', 'Fade'])
})

test('clearing every option leaves the field, not a broken one', () => {
  const config = withFields(
    customField({ id: 'f_1', label: 'Setup', type: 'select', options: ['A'] })
  )
  assert.deepEqual(setOptions(config, 'f_1', '').custom_fields[0].options, [])
})

// --- buckets --------------------------------------------------------------

test('bounds become ranges, with an open-ended one on the end', () => {
  const config = withFields(customField({ id: 'f_1', label: 'Delay', type: 'number' }))
  const after = setBuckets(config, 'f_1', '10, 30', 's')

  assert.deepEqual(after.custom_fields[0].buckets, [
    { label: '≤10s', max: 10 },
    { label: '10–30s', max: 30 },
    { label: '30s+', max: null },
  ])
})

test('bounds are sorted and deduplicated, however they were typed', () => {
  const config = withFields(customField({ id: 'f_1', label: 'Delay', type: 'number' }))
  const after = setBuckets(config, 'f_1', '30, 10, 30, junk, ')

  assert.deepEqual(after.custom_fields[0].buckets.map((b) => b.max), [10, 30, null])
})

test('no bounds means no buckets — recorded, never grouped', () => {
  const config = withFields(
    customField({
      id: 'f_1',
      label: 'Entry',
      type: 'number',
      buckets: [{ label: '≤10', max: 10 }],
    })
  )
  assert.deepEqual(setBuckets(config, 'f_1', '').custom_fields[0].buckets, [])
})

test('bucketBounds reads back what setBuckets was given', () => {
  const config = withFields(customField({ id: 'f_1', label: 'Delay', type: 'number' }))
  const after = setBuckets(config, 'f_1', '10, 30')

  assert.equal(bucketBounds(after.custom_fields[0]), '10, 30')
})

// --- whole-config ---------------------------------------------------------

test('a preset replaces the config rather than merging into it', () => {
  const existing = addField(addStrategy(blank(), 'Mine'), { label: 'My field' })
  const after = applyPreset(existing, MINIMAL_PRESET)

  assert.deepEqual(
    after.custom_fields.map((f) => f.label),
    MINIMAL_PRESET.config.custom_fields.map((f) => f.label)
  )
  assert.ok(
    !after.custom_fields.some((f) => f.label === 'My field'),
    'a half-applied preset would leave a field list nobody designed'
  )
})

test('applying a preset keeps the theme, which is not a preset’s business', () => {
  const light = migrate({ theme: 'light' })

  assert.equal(applyPreset(light, INTRADAY_FUTURES_PRESET).theme, 'light')
  assert.equal(clearConfig(light).theme, 'light')
})

test('clearing leaves a journal that still works, just with no vocabulary', () => {
  const cleared = clearConfig(applyPreset(blank(), INTRADAY_FUTURES_PRESET))

  assert.deepEqual(cleared.strategies, [])
  assert.deepEqual(cleared.custom_fields, [])
  assert.equal(cleared.instrument, null)
})

test('an unknown preset is refused rather than clearing the config', () => {
  assert.throws(() => applyPreset(blank(), null), /preset/i)
})

// --- statuses -------------------------------------------------------------

test('statuses come from one line each, trimmed, blanks and repeats dropped', () => {
  const after = setStatuses(blank(), '  Closed \n\n Stopped \nClosed\n')
  assert.deepEqual(after.statuses, ['Closed', 'Stopped'])
})

test('an empty status list falls back rather than being stored', () => {
  // A form with no statuses to pick from cannot record how a trade finished.
  assert.deepEqual(setStatuses(blank(), '   ').statuses, DEFAULT_STATUSES)
})

test('a fresh journal starts with the default statuses, not with none', () => {
  assert.deepEqual(blank().statuses, DEFAULT_STATUSES)
})

// --- currency -------------------------------------------------------------

test('the currency is a symbol, capped, and never accidentally empty', () => {
  assert.equal(setCurrency(blank(), 'kr').currency, 'kr')
  assert.equal(setCurrency(blank(), '').currency, '$', 'empty is not a symbol')
  // Capped so a paste cannot stretch every P&L cell in the table.
  assert.equal(setCurrency(blank(), 'kroner').currency, 'kron')
})

test('a single space is a real answer: no symbol at all', () => {
  // Some traders journal in R and points and want no unit. That has to be
  // storable, and distinguishable from "not set".
  assert.equal(setCurrency(blank(), ' ').currency, ' ')
})

test('a preset keeps the currency, which is not a preset’s business', () => {
  const kroner = setCurrency(blank(), 'kr')
  assert.equal(applyPreset(kroner, MINIMAL_PRESET).currency, 'kr')
  assert.equal(clearConfig(kroner).currency, 'kr')
})

// --- header tiles ---------------------------------------------------------

test('a tile turned off stays off, and the rest keep their order', () => {
  const after = toggleTile(blank(), 'profitFactor', false)
  const shown = visibleTiles(after).map((t) => t.id)

  assert.ok(!shown.includes('profitFactor'))
  assert.deepEqual(shown, DEFAULT_VISIBLE_STATS.filter((t) => t !== 'profitFactor'))
})

test('a tile turned back on returns to its canonical place', () => {
  const off = toggleTile(toggleTile(blank(), 'winRate', false), 'netPnl', false)
  const back = toggleTile(off, 'winRate', true)

  assert.deepEqual(
    visibleTiles(back).map((t) => t.id),
    DEFAULT_VISIBLE_STATS.filter((t) => t !== 'netPnl'),
    'order comes from the canonical list, not from the click order'
  )
})

test('the last tile cannot be turned off', () => {
  // An empty strip reads as a page that failed to load, and `visibleTiles`
  // treats an empty list as "all" — so storing one would turn them all back on.
  let config = blank()
  for (const id of DEFAULT_VISIBLE_STATS.slice(1)) config = toggleTile(config, id, false)

  assert.equal(visibleTiles(config).length, 1)
  assert.throws(() => toggleTile(config, DEFAULT_VISIBLE_STATS[0], false), /at least one/i)
})

test('an unknown stored tile id is ignored rather than rendered blank', () => {
  const config = migrate({ visible_stats: ['netPnl', 'from-an-older-version'] })
  assert.deepEqual(visibleTiles(config).map((t) => t.id), ['netPnl'])
})

test('an empty tile list means all of them, not none', () => {
  assert.deepEqual(visibleTiles(migrate({ visible_stats: [] })).length, DEFAULT_VISIBLE_STATS.length)
})

// --- onboarding -----------------------------------------------------------

test('a fresh journal has not been onboarded', () => {
  assert.equal(blank().onboarded, false)
})

test('skipping counts as onboarded, exactly like finishing', () => {
  // Someone who chose to start blank has decided. Greeting them with the same
  // card tomorrow turns a welcome into nagging.
  assert.equal(completeOnboarding(blank()).onboarded, true)
})

test('the walkthrough can be put back, and that is the only way back', () => {
  const done = completeOnboarding(blank())
  assert.equal(restartOnboarding(done).onboarded, false)
})

test('a preset or a clear does not walk the trader through the app again', () => {
  const done = completeOnboarding(blank())

  assert.equal(applyPreset(done, MINIMAL_PRESET).onboarded, true)
  assert.equal(clearConfig(done).onboarded, true, 'starting the vocabulary over is not a first run')
})
