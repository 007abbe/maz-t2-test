import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUILTIN_COLUMNS,
  DEFAULT_TABLE_COLUMNS,
  PINNED_COLUMNS,
  availableColumns,
  isBuiltinColumn,
  tableColumns,
} from './table-columns.js'
import { customField, migrate } from './config.js'
import { moveColumn, toggleColumn } from './config-edit.js'

const withField = (...fields) => migrate({ custom_fields: fields })

const ids = (config) => tableColumns(config).map((c) => c.id)

// --- what exists ----------------------------------------------------------

test('a fresh journal shows every built-in column', () => {
  assert.deepEqual(ids(migrate({})), DEFAULT_TABLE_COLUMNS)
})

test('the trader’s own fields are offered alongside the built-ins', () => {
  const config = withField(customField({ id: 'f_setup', label: 'Setup', type: 'select' }))
  const available = availableColumns(config).map((c) => c.id)

  assert.deepEqual(available, [...DEFAULT_TABLE_COLUMNS, 'f_setup'])
  assert.equal(isBuiltinColumn('f_setup'), false)
  assert.equal(isBuiltinColumn('status'), true)
})

test('a number field is marked numeric so its column right-aligns', () => {
  const config = withField(customField({ id: 'f_entry', label: 'Entry', type: 'number' }))
  const column = availableColumns(config).find((c) => c.id === 'f_entry')

  assert.equal(column.numeric, true)
})

// --- resolving a stored selection ----------------------------------------

test('a column pointing at a deleted field drops out rather than rendering blank', () => {
  const config = migrate({
    custom_fields: [],
    table_columns: ['trade', 'f_gone', 'pnl'],
  })

  assert.deepEqual(ids(config), ['trade', 'pnl'])
})

test('pinned columns come back even if the stored selection lost them', () => {
  // A journal with no identifier column has unclickable rows, and one with no
  // P&L is not a trading journal. Whatever is stored, these two render.
  const config = migrate({ table_columns: ['date', 'status'] })
  const shown = ids(config)

  for (const pinned of PINNED_COLUMNS) {
    assert.ok(shown.includes(pinned), `${pinned} must always render`)
  }
  assert.deepEqual(shown, ['trade', 'date', 'status', 'pnl'], 'and in their natural places')
})

test('the stored order is the rendered order', () => {
  const config = migrate({ table_columns: ['trade', 'pnl', 'date'] })
  assert.deepEqual(ids(config), ['trade', 'pnl', 'date'])
})

// --- editing --------------------------------------------------------------

test('turning a column off removes it; turning it back on restores its place', () => {
  const start = migrate({})
  const without = toggleColumn(start, 'status', false)

  assert.ok(!ids(without).includes('status'))
  assert.deepEqual(
    ids(toggleColumn(without, 'status', true)),
    DEFAULT_TABLE_COLUMNS,
    'a toggle off and on must not quietly move a column'
  )
})

test('a pinned column cannot be switched off', () => {
  const config = toggleColumn(migrate({}), 'pnl', false)
  assert.ok(ids(config).includes('pnl'))
})

test('a field added as a column lands after the built-ins', () => {
  const config = withField(customField({ id: 'f_setup', label: 'Setup' }))
  assert.deepEqual(ids(toggleColumn(config, 'f_setup', true)), [
    ...DEFAULT_TABLE_COLUMNS,
    'f_setup',
  ])
})

test('columns move one place at a time, and the ends do not wrap', () => {
  const config = migrate({ table_columns: ['trade', 'date', 'status', 'pnl'] })

  assert.deepEqual(ids(moveColumn(config, 'status', -1)), ['trade', 'status', 'date', 'pnl'])
  assert.deepEqual(ids(moveColumn(config, 'trade', -1)), ['trade', 'date', 'status', 'pnl'])
  assert.deepEqual(ids(moveColumn(config, 'pnl', 1)), ['trade', 'date', 'status', 'pnl'])
})

test('every built-in column has a label, since the header renders it', () => {
  for (const column of BUILTIN_COLUMNS) {
    assert.ok(column.label?.trim(), `${column.id} has no label`)
  }
})
