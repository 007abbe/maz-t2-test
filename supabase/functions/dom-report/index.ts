/**
 * DOM post-trade analysis — Layer 2.
 *
 * Layer 1 (src/domain/trade-stats.js) has already computed every number. This
 * function's only job is to have the model interpret finished figures: the
 * prompt forbids it from computing or inventing any, and the sample-size
 * thresholds arrive as data on the stats object rather than as prose it has to
 * apply by counting.
 *
 * Same pattern as finski-brief: the Anthropic key stays server-side, the prompt
 * is assembled here, and every request must resolve to a real signed-in user —
 * `verify_jwt` alone would admit the public anon key. Deploy without
 * `--no-verify-jwt`.
 */

import { CORS, json, requireUser } from '../_shared/auth.ts'

const MODEL = 'claude-sonnet-5'

/**
 * Six sections over a full stats object, and adaptive thinking shares this
 * budget with the response text — 2000 was sized for a browser
 * call with no thinking. Effort is `medium`, not Finski's `low`: finding a
 * language pattern across dozens of notes is real analysis, not prose wrapped
 * around a decided verdict.
 */
const MAX_TOKENS = 8000
const EFFORT = 'medium'

/** Occurrences a phrase needs before it may be reported as a pattern. */
const PATTERN_MIN_OCCURRENCES = 3

const MAX_NOTES = 200
const MAX_NOTE_CHARS = 400

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.slice(0, max) : ''

type Note = Record<string, unknown>

/** Caps how much buyer-defined vocabulary can reach the prompt. */
const MAX_FIELDS = 40
const MAX_FIELD_VALUES = 12
const FIELD_VALUE_CHARS = 60

/**
 * One trade's user-defined answers, bounded.
 *
 * Every key and value here was typed by the buyer, so both are truncated and
 * counted — a field list is data the prompt quotes, not instructions it obeys,
 * and an unbounded one is the cheapest way to push the real rules out of the
 * model's attention.
 */
function sanitiseFields(raw: unknown): Record<string, string | string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}

  // A field value can be a number or a toggle, not only text, and `text()`
  // answers '' to anything that is not a string — which would have silently
  // emptied every numeric answer the trader recorded.
  const one = (v: unknown): string =>
    typeof v === 'number' || typeof v === 'boolean'
      ? String(v).slice(0, FIELD_VALUE_CHARS)
      : text(v, FIELD_VALUE_CHARS)

  const out: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_FIELDS)) {
    const id = text(key, 40)
    if (!id) continue
    out[id] = Array.isArray(value)
      ? value.slice(0, MAX_FIELD_VALUES).map(one)
      : one(value)
  }
  return out
}

/** The id → name map, bounded the same way. */
function sanitiseLabels(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}

  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_FIELDS)) {
    const id = text(key, 40)
    const label = text(value, FIELD_VALUE_CHARS)
    if (id && label) out[id] = label
  }
  return out
}

function buildPrompt(input: {
  stats: Record<string, unknown>
  notes: Note[]
  scope: string
  reportDate: string
  minSample: number
  earlySignalMax: number
  strategies: string[]
  fieldLabels: Record<string, string>
  instrument: string
}): string {
  const { stats, notes, scope, reportDate, minSample, earlySignalMax, strategies, instrument, fieldLabels } = input

  const fieldEntries = Object.entries(fieldLabels)
  const fieldLines = fieldEntries.length
    ? fieldEntries.map(([id, label]) => `  - ${label} (id: ${id})`).join('
')
    : '  none configured'

  const strategyLines = strategies.length
    ? strategies.map((s) => `  - ${s}`).join('
')
    : '  none configured — trades are grouped as untagged'

  return `You are DOM, the post-trade analyst for a discretionary intraday futures trader.

THE TRADER'S OWN SETUP (they configured this; treat it as given):
- Instrument: ${instrument || 'not specified'}
- Strategies they trade:
${strategyLines}

You do not know the internals of these strategies. Never state, infer or reconstruct what a strategy's rules are — refer to one only by the name above, and only to report what the statistics say about it.

- Fields they record on each trade (these are their own, not built in):
${fieldLines}

Statistics under "byCustom", and the "fields" object on each note, are keyed by the field ids above. Always refer to a field by its NAME, never by its id. A field id you do not find in that list belongs to a field they have since deleted — report it as "a removed field" and do not guess what it was.

Below are (1) PRECOMPUTED STATISTICS and (2) the trader's own THESIS and HINDSIGHT notes per trade.

STRICT RULES:
- Every numeric claim must come from the PRECOMPUTED STATISTICS. Never compute, derive, or invent a number. If a figure you want is not present, say it is not available rather than working it out.
- Sample size is already decided for you. Each group carries "insufficient": true when n < ${minSample} — list those under INSUFFICIENT DATA and draw no conclusions from them. Groups carrying "earlySignal": true (n ${minSample}-${earlySignalMax}) may be mentioned, but must be marked "early signal, small sample".
- Note that "avgR" is averaged over "rSample", which can be smaller than "n" — trades logged without declared risk have no R. Never describe avgR as covering the whole group when rSample is lower than n.
- LANGUAGE PATTERNS section: look for recurring words, phrases or themes in the trader's own notes that co-occur with a consistent outcome. Only report a pattern appearing in ${PATTERN_MIN_OCCURRENCES} or more trades. Quote the trader's EXACT words in quotation marks, list the trade numbers (#), and state the outcomes. Do NOT paraphrase, do NOT psychoanalyse, do NOT infer emotions that are not literally written. If nothing reaches ${PATTERN_MIN_OCCURRENCES} occurrences, write "No recurring language pattern at threshold (${PATTERN_MIN_OCCURRENCES}+) yet."
- Notes may be written in any language, or a mix. Quote in the original language, do not translate.
- Be direct and specific. No praise, no filler, no generic trading advice.

OUTPUT FORMAT (plain text, these exact sections):
DOM REPORT — ${reportDate}
SAMPLE: ${scope}

WHAT THE NUMBERS SAY
(3-6 lines, only stats-backed claims)

PATTERN OF THE PERIOD
(the single most important stats-backed finding)

LANGUAGE PATTERNS
(per the strict rules above)

ONE THING TOMORROW
(exactly one instruction)

INSUFFICIENT DATA
(groups carrying "insufficient": true, one line each)

PRECOMPUTED STATISTICS:
${JSON.stringify(stats, null, 1)}

TRADE NOTES:
${JSON.stringify(notes, null, 1)}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  const user = await requireUser(req)
  if (!user) return json({ error: 'Sign in required.' }, 401)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Body must be JSON' }, 400)
  }

  // A setup check, not a request. The Settings screen asks two questions — is
  // this function deployed, and is the key set — and neither is worth a token.
  // Answered before the key check below, because "deployed but unconfigured" is
  // the whole state it exists to distinguish.
  //
  // It reports only whether the variable is present. Never its value, never a
  // prefix, never a length: the key stays server-side, and a probe that leaked
  // any part of it would defeat the reason it lives here.
  if (body.probe === true) {
    return json({ ok: true, keyConfigured: !!Deno.env.get('ANTHROPIC_API_KEY') })
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    return json(
      { error: 'ANTHROPIC_API_KEY is not set on this project. Add it under Project Settings → Edge Functions → Secrets.' },
      500
    )
  }

  const stats = body.stats as Record<string, unknown> | undefined
  const overall = stats?.overall as { n?: unknown } | undefined
  if (!stats || typeof overall?.n !== 'number') {
    return json({ error: 'stats.overall.n is required — send a computed stats object' }, 400)
  }
  if (overall.n === 0) {
    return json({ error: 'Nothing to analyse: the selection is empty' }, 400)
  }

  const reportDate = text(body.reportDate, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
    // Supplied by the client because only it knows the trader's local date;
    // this function runs in UTC.
    return json({ error: 'reportDate must be YYYY-MM-DD' }, 400)
  }

  const rawNotes = Array.isArray(body.notes) ? body.notes : []
  if (rawNotes.length > MAX_NOTES) {
    return json({ error: `At most ${MAX_NOTES} trades per report` }, 400)
  }

  const notes: Note[] = rawNotes.map((raw) => {
    const n = (raw ?? {}) as Record<string, unknown>
    return {
      num: typeof n.num === 'number' ? n.num : null,
      outcome: text(n.outcome, 4),
      r: typeof n.r === 'number' ? n.r : null,
      // Free text the trader named, so it is bounded generously rather than at
      // the width of any particular vocabulary.
      strategy: text(n.strategy, 30) || null,
      // The trader's own fields, keyed by field id. Bounded per value rather
      // than per field name, because both halves are strings the buyer typed
      // and both reach the prompt.
      fields: sanitiseFields(n.fields),
      thesis: text(n.thesis, MAX_NOTE_CHARS),
      hindsight: text(n.hindsight, MAX_NOTE_CHARS),
    }
  })

  const thresholds = (stats.thresholds ?? {}) as Record<string, unknown>

  const prompt = buildPrompt({
    stats,
    notes,
    scope: text(body.scope, 120) || `${overall.n} trades`,
    reportDate,
    minSample: typeof thresholds.minSample === 'number' ? thresholds.minSample : 5,
    earlySignalMax:
      typeof thresholds.earlySignalMax === 'number' ? thresholds.earlySignalMax : 9,
    // The buyer's own configuration, forwarded from the client and bounded like
    // every other caller-supplied string, because these reach the prompt.
    strategies: Array.isArray(body.strategies)
      ? body.strategies.slice(0, 12).map((t) => text(t, 60))
      : [],
    fieldLabels: sanitiseLabels(body.fieldLabels),
    instrument: text(body.instrument, 30),
  })

  let response: Response
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        output_config: { effort: EFFORT },
        messages: [{ role: 'user', content: prompt }],
      }),
    })
  } catch (err) {
    return json({ error: `Could not reach Anthropic: ${(err as Error).message}` }, 502)
  }

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}))
    const message =
      (detail as { error?: { message?: string } })?.error?.message ??
      `Anthropic API error ${response.status}`
    return json({ error: message }, response.status === 429 ? 429 : 502)
  }

  const result = await response.json()

  // A refusal returns HTTP 200 with an empty content array.
  if (result.stop_reason === 'refusal') {
    return json({ error: 'Anthropic declined this request.' }, 422)
  }

  const report = (result.content ?? [])
    .filter((block: { type: string }) => block.type === 'text')
    .map((block: { text: string }) => block.text)
    .join('\n')
    .trim()

  if (!report) {
    return json({ error: `No report text returned (stop_reason: ${result.stop_reason})` }, 502)
  }

  return json({
    report,
    truncated: result.stop_reason === 'max_tokens',
    model: result.model,
  })
})
