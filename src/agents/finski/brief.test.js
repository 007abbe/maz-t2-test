import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildBriefInputs,
  formatBrief,
  generateBrief,
  toFunctionPayload,
  toStoredData,
  yesterdayContext,
} from './brief.js'

/** 08:00 ET on a summer weekday. */
const NOW = Date.parse('2026-07-29T08:00:00-04:00')

const CALENDAR = [
  {
    title: 'CPI m/m',
    country: 'USD',
    date: '2026-07-29T08:30:00-04:00',
    impact: 'High',
    forecast: '0.3%',
    previous: '0.2%',
  },
  {
    title: 'German ifo',
    country: 'EUR',
    date: '2026-07-29T04:00:00-04:00',
    impact: 'High',
    forecast: '',
    previous: '',
  },
]

const QUIET_VIX = { now: 15, prev: 15 }
const NO_LEVELS = { onHigh: null, onLow: null, priorClose: null }

/** Two strategies, as the buyer would have configured them. */
const CONFIG = {
  instrument: 'MNQ',
  session: '09:30–12:00 ET',
  strategies: [
    { id: 'model_a', label: 'Opening drive', setups: ['Go with', 'Fade'] },
    { id: 'model_b', label: 'Midday reversion', setups: [] },
  ],
}

const inputs = (overrides = {}) =>
  buildBriefInputs({
    calendar: CALENDAR,
    vix: QUIET_VIX,
    levels: NO_LEVELS,
    now: NOW,
    ...overrides,
  })

test('buildBriefInputs keeps only the events the brief may speak about', () => {
  const result = inputs()

  assert.deepEqual(
    result.events.map((e) => e.title),
    ['CPI m/m'],
    'non-USD events are filtered out before the brief sees them'
  )
})

test('yesterdayContext carries the trader\'s own words, not a derived label', () => {
  const result = inputs({
    calendar: [],
    trades: [
      { date: '2026-07-28T15:00', hindsight: 'Chopped all session, stood down early' },
    ],
  })

  assert.deepEqual(result.yesterday, {
    date: '2026-07-28',
    notes: 'Chopped all session, stood down early',
  })
})

test('yesterdayContext falls back to the thesis, then to nothing', () => {
  assert.equal(
    yesterdayContext([{ date: '2026-07-28T15:00', thesis: 'Expected a trend day' }], NOW).notes,
    'Expected a trend day'
  )
  assert.equal(yesterdayContext([{ date: '2026-07-28T15:00' }], NOW).notes, null)
  assert.equal(yesterdayContext([], NOW), null)
})

test('yesterdayContext ignores today\'s own trades', () => {
  // The brief is written pre-market, so a row dated today is either a leftover
  // or a mistake — either way it is not yesterday.
  assert.equal(yesterdayContext([{ date: '2026-07-29T09:45' }], NOW), null)
})

test('the function payload carries labelled times and no raw instants', () => {
  const payload = toFunctionPayload(inputs())

  assert.deepEqual(payload.events, [
    {
      title: 'CPI m/m',
      impact: 'High',
      timeLabel: '08:30 ET / 14:30 CET',
      forecast: '0.3%',
      previous: '0.2%',
    },
  ])
  assert.ok(!('dt' in payload.events[0]), 'the function never compares times')
})

test('the payload names the buyer\'s strategies and nothing about their rules', () => {
  const payload = toFunctionPayload(inputs({ config: CONFIG }))

  assert.deepEqual(payload.strategies, ['Opening drive', 'Midday reversion'])
  assert.equal(payload.instrument, 'MNQ')
  assert.equal(payload.session, '09:30–12:00 ET')

  // Labels reach the prompt because the model cannot resolve an id. Setups do
  // not: how a strategy is entered is the trader's business, not the briefer's.
  const json = JSON.stringify(payload)
  assert.ok(!json.includes('Go with'), 'setups must not reach the prompt')
  assert.ok(!json.includes('model_a'), 'ids are meaningless to the model')
})

test('an unconfigured journal still produces a payload', () => {
  const payload = toFunctionPayload(inputs())

  assert.deepEqual(payload.strategies, [])
  assert.equal(payload.instrument, '')
  assert.equal(payload.session, '')
})

test('the stored row keeps both zones for reading a brief back later', () => {
  const stored = toStoredData(inputs())

  assert.deepEqual(stored.events[0], {
    title: 'CPI m/m',
    impact: 'High',
    timeET: '08:30',
    timeCET: '14:30',
    timeLabel: '08:30 ET / 14:30 CET',
    forecast: '0.3%',
    previous: '0.2%',
  })
  assert.deepEqual(stored.vix, QUIET_VIX)
})

test('formatBrief dates the brief in New York time', () => {
  const brief = formatBrief({ prose: 'CONDITIONS\nCalm.', now: NOW })

  assert.equal(brief, 'FINSKI BRIEF — 2026-07-29\n\nCONDITIONS\nCalm.')
})

test('formatBrief still dates to today when written late in the CET evening', () => {
  // 23:00 CET on the 29th is already the 30th in UTC.
  const cetEvening = Date.parse('2026-07-29T23:00:00+02:00')
  const brief = formatBrief({ prose: 'CONDITIONS\nCalm.', now: cetEvening })

  assert.match(brief, /FINSKI BRIEF — 2026-07-29/)
})

// --- generateBrief --------------------------------------------------------

const deps = (overrides = {}) => {
  const saved = []
  const requested = []
  return {
    saved,
    requested,
    deps: {
      fetchCalendar: async () => ({ events: CALENDAR, fromCache: false }),
      requestBrief: async (payload) => {
        requested.push(payload)
        return { prose: 'CONDITIONS\nCalm.' }
      },
      saveBrief: async (row) => {
        saved.push(row)
      },
      ...overrides,
    },
  }
}

test('generateBrief runs calendar → prose → save', async () => {
  const { deps: d, saved, requested } = deps()

  const result = await generateBrief(
    { vix: QUIET_VIX, levels: NO_LEVELS, config: CONFIG, now: NOW },
    d
  )

  assert.match(result.brief, /^FINSKI BRIEF — 2026-07-29/)
  assert.equal(result.saved, true)
  assert.equal(requested.length, 1)
  assert.deepEqual(requested[0].strategies, ['Opening drive', 'Midday reversion'])
  assert.equal(saved.length, 1)
  assert.equal(saved[0].brief, result.brief)
})

test('generateBrief reports progress in order', async () => {
  const steps = []
  const { deps: d } = deps()

  await generateBrief({ vix: QUIET_VIX, levels: NO_LEVELS, now: NOW }, {
    ...d,
    onProgress: (step) => steps.push(step),
  })

  assert.deepEqual(steps, ['Fetching calendar…', 'Writing brief…'])
})

test('generateBrief surfaces a stale calendar without failing', async () => {
  const { deps: d } = deps({
    fetchCalendar: async () => ({ events: CALENDAR, fromCache: true, stale: true }),
  })

  const result = await generateBrief(
    { vix: QUIET_VIX, levels: NO_LEVELS, now: NOW },
    d
  )

  assert.equal(result.stale, true)
  assert.equal(result.fromCache, true)
  assert.ok(result.brief, 'a stale calendar still produces a brief')
})

test('a failed save does not lose the brief', async () => {
  const { deps: d } = deps({
    saveBrief: async () => {
      throw new Error('insert failed')
    },
  })

  const result = await generateBrief(
    { vix: QUIET_VIX, levels: NO_LEVELS, now: NOW },
    d
  )

  assert.equal(result.saved, false)
  assert.equal(result.saveError.message, 'insert failed')
  assert.match(result.brief, /FINSKI BRIEF/, 'the text is still returned')
})

test('a failed calendar fetch aborts before spending a request', async () => {
  const { deps: d, requested } = deps({
    fetchCalendar: async () => {
      throw new Error('Calendar unavailable')
    },
  })

  await assert.rejects(
    generateBrief({ vix: QUIET_VIX, levels: NO_LEVELS, now: NOW }, d),
    /Calendar unavailable/
  )
  assert.equal(requested.length, 0)
})

test('a truncated response is flagged through to the caller', async () => {
  const { deps: d } = deps({
    requestBrief: async () => ({ prose: 'CONDITIONS\nCal', truncated: true }),
  })

  const result = await generateBrief(
    { vix: QUIET_VIX, levels: NO_LEVELS, now: NOW },
    d
  )

  assert.equal(result.truncated, true)
})
