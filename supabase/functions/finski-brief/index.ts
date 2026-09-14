/**
 * Finski pre-market brief — LLM leg.
 *
 * Exists so the Anthropic key stays server-side. Calling the API
 * straight from the browser with `anthropic-dangerous-direct-browser-access`,
 * which exposes the key to anything running on the page.
 *
 * The prompt is assembled here, not accepted from the client. If this forwarded
 * caller-supplied prompt text it would be an open generation proxy for anyone
 * holding a session; taking structured data against a fixed template bounds it
 * to Finski briefs.
 *
 * Auth: `verify_jwt` is necessary but not sufficient — the public anon key is a
 * valid project JWT. Every request is resolved to a real signed-in user via
 * `requireUser`. Deploy without `--no-verify-jwt`.
 */

import { CORS, json, requireUser } from '../_shared/auth.ts'

const MODEL = 'claude-sonnet-5'

/**
 * Adaptive thinking is on by default for this model and `max_tokens` caps
 * thinking *and* response text together, so the budget is set well above what
 * the four sections need. Effort is `low`: the task is short, scoped, and the
 * hard decision (the risk level) was already made deterministically upstream.
 */
const MAX_TOKENS = 4000
const EFFORT = 'low'


/** Trims and bounds any caller-supplied string before it reaches the prompt. */
const text = (value: unknown, max = 200): string =>
  typeof value === 'string' ? value.slice(0, max) : ''

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

type BriefEvent = {
  title: string
  impact: string
  timeLabel: string
  forecast: string
  previous: string
}

function buildPrompt(input: {
  strategies: string[]
  session: string
  instrument: string
  vix: { now: number | null; prev: number | null }
  vvix: number | null
  levels: { onHigh: number | null; onLow: number | null; priorClose: number | null }
  events: BriefEvent[]
  yesterday: { date: string; notes: string | null } | null
}): string {
  const { strategies, session, instrument, vix, vvix, levels, events, yesterday } = input

  const vixChange =
    vix.now != null && vix.prev
      ? `${(((vix.now - vix.prev) / vix.prev) * 100).toFixed(1)}% d/d`
      : 'n/a'

  const manualLevels =
    [
      levels.onHigh != null ? `ON High ${levels.onHigh}` : '',
      levels.onLow != null ? `ON Low ${levels.onLow}` : '',
      levels.priorClose != null ? `Prior close ${levels.priorClose}` : '',
    ]
      .filter(Boolean)
      .join(', ') || 'none provided'

  const eventLines = events.length
    ? events
        .map(
          (e) =>
            `  ${e.timeLabel} — ${e.title} [${e.impact}]` +
            `${e.forecast ? ` fcst ${e.forecast}` : ''}` +
            `${e.previous ? ` prev ${e.previous}` : ''}`
        )
        .join('\n')
    : '  none'

  const strategyLines = strategies.length
    ? strategies.map((s) => `  - ${s}`).join('\n')
    : '  none configured'

  return `You are Finski, the pre-market briefer for a discretionary intraday futures trader.

THE TRADER'S OWN SETUP (they configured this; treat it as given):
- Instrument: ${instrument || 'not specified'}
- Session: ${session || 'not specified'}
- Strategies they trade:
${strategyLines}

You do not know the internals of these strategies and must not guess at them. Refer to a strategy only by the name given above, and only to say how the day's conditions might affect trading it.

DATA:
- VIX: ${vix.now ?? 'n/a'} (prev close ${vix.prev ?? 'n/a'}, ${vixChange})${vvix != null ? ` | VVIX: ${vvix}` : ''}
- Yesterday (own journal): ${
    yesterday
      ? `${yesterday.date}${yesterday.notes ? ` — ${yesterday.notes}` : ''}`
      : 'no prior day logged'
  }
- Manual levels: ${manualLevels}
- Today's USD events (High/Medium impact):
${eventLines}

STRICT RULES:
- NEVER predict direction. No bullish/bearish, no bias, no targets. Volatility state and playability only.
- Only use the data above. No outside knowledge about current markets.
- Never invent a rule, threshold or condition for the trader's strategies. You have not been told them.
- Every time you write is already labelled with its zone, e.g. "08:30 ET / 14:30 CET". Reproduce those labels exactly as given. Never write a bare time, and never convert between zones yourself.
- Volatility state cannot be assessed pre-market with any confidence; say so rather than implying otherwise.
- Concise. Plain text. Write everything in English.

OUTPUT FORMAT (exactly these sections):
CONDITIONS
(2-3 lines: volatility state from VIX/VVIX + yesterday's context)

EVENTS
(each relevant event with its labelled time + one line handling instruction, e.g. "sit on hands 08:15–09:00 ET / 14:15–15:00 CET")

LEVELS
(from manual levels if provided; otherwise write "No level data provided — mark your own levels before open")

RISK
(ONE sentence: the single biggest way this day punishes an intraday trader)`
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

  const rawVix = (body.vix ?? {}) as Record<string, unknown>
  const rawLevels = (body.levels ?? {}) as Record<string, unknown>
  const rawYesterday = body.yesterday as Record<string, unknown> | null

  const prompt = buildPrompt({
    // The buyer's own configuration, forwarded from the client. Bounded like
    // every other caller-supplied string: these reach the prompt.
    strategies: Array.isArray(body.strategies)
      ? body.strategies.slice(0, 12).map((t) => text(t, 60))
      : [],
    session: text(body.session, 60),
    instrument: text(body.instrument, 30),
    vix: { now: num(rawVix.now), prev: num(rawVix.prev) },
    vvix: num(body.vvix),
    levels: {
      onHigh: num(rawLevels.onHigh),
      onLow: num(rawLevels.onLow),
      priorClose: num(rawLevels.priorClose),
    },
    events: Array.isArray(body.events)
      ? body.events.slice(0, 40).map((raw) => {
          const e = (raw ?? {}) as Record<string, unknown>
          return {
            title: text(e.title, 120),
            impact: text(e.impact, 10),
            timeLabel: text(e.timeLabel, 40),
            forecast: text(e.forecast, 20),
            previous: text(e.previous, 20),
          }
        })
      : [],
    yesterday: rawYesterday
      ? {
          date: text(rawYesterday.date, 10),
          notes: text(rawYesterday.notes, 200) || null,
        }
      : null,
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

  // Guard before reading content: a refusal returns HTTP 200 with an empty
  // content array, so indexing straight into it would throw.
  if (result.stop_reason === 'refusal') {
    return json({ error: 'Anthropic declined this request.' }, 422)
  }

  const prose = (result.content ?? [])
    .filter((block: { type: string }) => block.type === 'text')
    .map((block: { text: string }) => block.text)
    .join('\n')
    .trim()

  if (!prose) {
    return json({ error: `No brief text returned (stop_reason: ${result.stop_reason})` }, 502)
  }

  return json({
    prose,
    truncated: result.stop_reason === 'max_tokens',
    model: result.model,
  })
})
