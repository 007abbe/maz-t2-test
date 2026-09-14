import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BLANK_CONFIG,
  SCHEMA_VERSION,
  buildCustom,
  customField,
  fieldLabel,
  fieldsFor,
  findField,
  isConfigured,
  loadConfig,
  migrate,
  normaliseFieldValue,
  strategyLabel,
} from './config.js'
import { PRESETS, findPreset } from './presets.js'

/**
 * `fieldId` uses crypto.getRandomValues, which node has; these tests pass ids
 * explicitly anyway, because an id that appears in an assertion has to be
 * readable.
 */
const field = (id, label, rest = {}) => customField({ id, label, ...rest })

// --- the blank state ------------------------------------------------------

test('a journal with no settings row gets a blank config, not an error', () => {
  const config = loadConfig(undefined)

  assert.deepEqual(config.strategies, [])
  assert.deepEqual(config.custom_fields, [])
  assert.equal(config.instrument, null)
  assert.equal(isConfigured(config), false)
})

test('t2 ships with no vocabulary at all', () => {
  // The whole premise of the rebuild: no setups, no tags, no strategies. A
  // "sensible default" here would be shipping somebody else's trading model.
  assert.deepEqual(BLANK_CONFIG.strategies, [])
  assert.deepEqual(BLANK_CONFIG.custom_fields, [])
})

// --- migrate --------------------------------------------------------------

test('a hand-edited or older config is read forward, never rejected', () => {
  const config = migrate({ strategies: null, custom_fields: 'nonsense', labels: 7 })

  assert.deepEqual(config.strategies, [])
  assert.deepEqual(config.custom_fields, [])
  assert.deepEqual(config.labels, {})
  assert.equal(config.schema_version, SCHEMA_VERSION)
})

test('a field with no id or no label is dropped rather than rendered nameless', () => {
  const config = migrate({
    custom_fields: [
      { id: 'f_ok', label: 'Setup', type: 'select' },
      { id: 'f_bad' },
      { label: 'No id' },
    ],
  })

  assert.deepEqual(config.custom_fields.map((f) => f.id), ['f_ok'])
})

test('an unknown field type falls back to text rather than rendering nothing', () => {
  const [f] = migrate({ custom_fields: [{ id: 'f_x', label: 'X', type: 'wormhole' }] }).custom_fields
  assert.equal(f.type, 'text')
})

// --- labels resolve for display only --------------------------------------

test('renaming a strategy is a label edit, not a data change', () => {
  const before = migrate({ strategies: [{ id: 'model_a', label: 'Opening drive' }] })
  const after = migrate({ strategies: [{ id: 'model_a', label: 'Trend continuation' }] })

  // Same stored id on the trade; only what the trader reads changes.
  assert.equal(strategyLabel(before, 'model_a'), 'Opening drive')
  assert.equal(strategyLabel(after, 'model_a'), 'Trend continuation')
})

test('a deleted strategy still shows something groupable, not a blank', () => {
  assert.equal(strategyLabel(migrate({}), 'model_c'), 'model_c')
})

test('a deleted field still names itself in the stats it collected', () => {
  const config = migrate({ custom_fields: [] })

  assert.equal(findField(config, 'f_gone'), null)
  assert.equal(fieldLabel(config, 'f_gone'), 'f_gone')
})

// --- scoping --------------------------------------------------------------

test('unscoped fields show on every trade; scoped ones only on their strategy', () => {
  const config = migrate({
    custom_fields: [
      field('f_tags', 'Tags', { type: 'multiselect' }),
      field('f_setup_a', 'Setup', { type: 'select', strategy: 'model_a' }),
      field('f_setup_b', 'Setup', { type: 'select', strategy: 'model_b' }),
    ],
  })

  assert.deepEqual(fieldsFor(config, null).map((f) => f.id), ['f_tags'])
  assert.deepEqual(fieldsFor(config, 'model_a').map((f) => f.id), ['f_tags', 'f_setup_a'])
  assert.deepEqual(fieldsFor(config, 'model_b').map((f) => f.id), ['f_tags', 'f_setup_b'])
})

test('unscoped fields come first, so the form grows at the bottom', () => {
  const config = migrate({
    custom_fields: [
      field('f_scoped', 'Setup', { strategy: 'model_a' }),
      field('f_global', 'Mood'),
    ],
  })

  assert.deepEqual(fieldsFor(config, 'model_a').map((f) => f.id), ['f_global', 'f_scoped'])
})

// --- value normalisation --------------------------------------------------

test('an unanswered field is absent from custom, not stored as null', () => {
  const fields = [
    field('f_text', 'Note'),
    field('f_num', 'Entry', { type: 'number' }),
    field('f_multi', 'Tags', { type: 'multiselect' }),
    field('f_toggle', 'Scaled out', { type: 'toggle' }),
  ]

  assert.deepEqual(
    buildCustom(fields, { f_text: '   ', f_num: '', f_multi: new Set(), f_toggle: false }),
    {}
  )
})

test('a number is stored as a number, so the stats can bucket it', () => {
  assert.equal(normaliseFieldValue(field('f', 'x', { type: 'number' }), '19875.50'), 19875.5)
  assert.equal(normaliseFieldValue(field('f', 'x', { type: 'number' }), 'abc'), undefined)
  assert.equal(normaliseFieldValue(field('f', 'x', { type: 'number' }), 0), 0, 'zero is an answer')
})

test('a multiselect stores an array, trimmed, with the blanks dropped', () => {
  const f = field('f', 'Tags', { type: 'multiselect' })
  assert.deepEqual(normaliseFieldValue(f, new Set([' a ', '', 'b'])), ['a', 'b'])
})

test('only a true toggle is stored', () => {
  // False is the state of every trade that never saw the field, so writing it
  // would make "not answered" and "answered no" indistinguishable anyway.
  const f = field('f', 'Scaled', { type: 'toggle' })
  assert.equal(normaliseFieldValue(f, true), true)
  assert.equal(normaliseFieldValue(f, false), undefined)
})

test('buildCustom writes only the fields it was given', () => {
  const custom = buildCustom([field('f_keep', 'Keep')], { f_keep: 'yes', f_other: 'no' })
  assert.deepEqual(custom, { f_keep: 'yes' })
})

// --- presets --------------------------------------------------------------

test('every preset is a config the loader accepts unchanged', () => {
  for (const preset of PRESETS) {
    const config = migrate(preset.config)
    assert.equal(config.schema_version, SCHEMA_VERSION, preset.id)
    assert.equal(
      config.custom_fields.length,
      (preset.config.custom_fields ?? []).length,
      `${preset.id}: migrate dropped a field, so the preset defines an invalid one`
    )
  }
})

test('preset field ids are stable and unique, so a preset can be upgraded', () => {
  for (const preset of PRESETS) {
    const ids = (preset.config.custom_fields ?? []).map((f) => f.id)
    assert.equal(new Set(ids).size, ids.length, `${preset.id} repeats a field id`)
  }
})

test('every field a preset scopes points at a strategy that preset defines', () => {
  for (const preset of PRESETS) {
    const strategies = new Set((preset.config.strategies ?? []).map((s) => s.id))
    for (const f of preset.config.custom_fields ?? []) {
      if (!f.strategy) continue
      assert.ok(
        strategies.has(f.strategy),
        `${preset.id}: field ${f.id} is scoped to ${f.strategy}, which it never defines`
      )
    }
  }
})

test('there are exactly three presets, and they are findable by id', () => {
  // Three, because none of them is the right way and a trader should be able to
  // hold all of them in their head while choosing. "Start from nothing" is a
  // button on the settings screen, not a fourth preset pretending to be one.
  assert.equal(PRESETS.length, 3)
  for (const preset of PRESETS) {
    assert.equal(findPreset(preset.id), preset)
  }
  assert.equal(findPreset('nope'), null)
})

test('the presets express the same idea in different shapes', () => {
  // The reason to ship more than one: they demonstrate the machinery's range.
  const typeOf = (presetId, label) =>
    findPreset(presetId).config.custom_fields.find((f) => f.label === label)?.type

  assert.equal(typeOf('minimal', 'Target'), 'text', 'a free box')
  assert.equal(typeOf('intraday-futures', 'Target'), 'multiselect', 'a list, plus free entry')
  assert.equal(typeOf('swing', 'Target'), undefined, 'not a field at all')
})

test('every preset carries the copy the settings screen renders', () => {
  for (const preset of PRESETS) {
    for (const key of ['id', 'name', 'summary', 'detail']) {
      assert.ok(preset[key]?.trim(), `${preset.id} is missing ${key}`)
    }
  }
})
