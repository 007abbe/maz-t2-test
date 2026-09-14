/**
 * The brief pipeline: calendar → prose → stored row.
 *
 * The builders are pure and injected-clock; `generateBrief` is the thin I/O
 * sequence over them, with every dependency passed in so it can run against
 * fakes. Nothing here imports Supabase — `ui.js` wires the real calls.
 */

import { etDate } from '../../domain/et-session.js'
import { todayUsdEvents } from './calendar.js'

/**
 * Yesterday's journal, as one line of context for the brief.
 *
 * Deliberately thin: the buyer's own notes and nothing derived from them. The
 * brief describes conditions, and anything the journal could say about *how to
 * trade* them would be a rule this product does not have.
 */
export function yesterdayContext(trades, now) {
  const today = etDate(now)

  // Lexicographic order is chronological order for `YYYY-MM-DDTHH:mm` text, so
  // the latest row before today is the last one that sorts under it.
  const prior = [...trades]
    .filter((t) => (t.date ?? '') < today)
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
    .pop()

  if (!prior) return null

  return {
    date: (prior.date ?? '').slice(0, 10),
    notes: (prior.hindsight || prior.thesis || '').slice(0, 200) || null,
  }
}

/**
 * Everything the brief was written from, decided locally.
 *
 * @param {object} input
 * @param {Array<object>} input.calendar full weekly feed
 * @param {{now: number|null, prev: number|null}} input.vix
 * @param {number|null} [input.vvix]
 * @param {{onHigh: number|null, onLow: number|null, priorClose: number|null}} [input.levels]
 * @param {Array<object>} [input.trades] for yesterday's context line
 * @param {object} [input.config] the buyer's configuration
 * @param {number} input.now epoch ms
 */
export function buildBriefInputs({
  calendar,
  vix,
  vvix = null,
  levels = { onHigh: null, onLow: null, priorClose: null },
  trades = [],
  config = null,
  now,
}) {
  const events = todayUsdEvents(calendar, now)
  const yesterday = yesterdayContext(trades, now)

  return { events, yesterday, vix, vvix, levels, config }
}

/**
 * The request body for the Edge Function. Deliberately narrow: only the fields
 * the prompt template reads, with `dt` dropped — the function never compares
 * times, it only reproduces the labels we send it.
 *
 * Strategies are sent as *labels*, not ids, because this is the one place the
 * text is read by something that cannot look an id up. Nothing is sent about
 * what a strategy does, because the journal does not know and the prompt
 * forbids the model from guessing.
 */
export function toFunctionPayload({ vix, vvix, levels, events, yesterday, config }) {
  return {
    vix,
    vvix,
    levels,
    yesterday,
    strategies: (config?.strategies ?? []).map((s) => s.label),
    instrument: config?.instrument ?? '',
    session: config?.session ?? '',
    events: events.map((e) => ({
      title: e.title,
      impact: e.impact,
      timeLabel: e.timeLabel,
      forecast: e.forecast ?? '',
      previous: e.previous ?? '',
    })),
  }
}

/**
 * The `data` column: the inputs a stored brief was written from, so an old
 * brief can be read back against the tape it described.
 */
export function toStoredData({ vix, vvix, levels, events, yesterday }) {
  return {
    vix,
    vvix,
    levels,
    yesterday,
    events: events.map((e) => ({
      title: e.title,
      impact: e.impact,
      timeET: e.timeET,
      timeCET: e.timeCET,
      timeLabel: e.timeLabel,
      forecast: e.forecast ?? null,
      previous: e.previous ?? null,
    })),
  }
}

/**
 * Header + prose, as stored and displayed. The date is the New York trading
 * date rather than the UTC one, which rolls over mid-evening in Europe and
 * would date an evening-written brief to the following session.
 */
export function formatBrief({ prose, now }) {
  return [`FINSKI BRIEF — ${etDate(now)}`, prose].filter(Boolean).join('\n\n')
}

/**
 * Runs the whole pipeline and stores the result.
 *
 * A failed save does not fail the brief — the text is already written and the
 * trader needs it before the open; losing the history row is the lesser cost.
 * The caller is told via `saved`.
 *
 * @returns {Promise<{brief: string, events: Array<object>, fromCache: boolean,
 *   stale: boolean, truncated: boolean, saved: boolean, saveError: Error|null}>}
 */
export async function generateBrief(
  { vix, vvix = null, levels, trades = [], config = null, now = Date.now() },
  { fetchCalendar, requestBrief, saveBrief, onProgress = () => {} }
) {
  onProgress('Fetching calendar…')
  const calendar = await fetchCalendar()

  const inputs = buildBriefInputs({
    calendar: calendar.events,
    vix,
    vvix,
    levels,
    trades,
    config,
    now,
  })

  onProgress('Writing brief…')
  const { prose, truncated = false } = await requestBrief(toFunctionPayload(inputs))

  const brief = formatBrief({ prose, now })

  let saved = true
  let saveError = null
  try {
    await saveBrief({ brief, data: toStoredData(inputs) })
  } catch (err) {
    saved = false
    saveError = err
  }

  return {
    brief,
    events: inputs.events,
    fromCache: calendar.fromCache ?? false,
    stale: calendar.stale ?? false,
    truncated,
    saved,
    saveError,
  }
}
