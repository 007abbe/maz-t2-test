import { supabase } from '../lib/supabase.js'

/**
 * Whether the two agents are ready to run, and if not, why not.
 *
 * DOM and Finski call Anthropic from an Edge Function inside the buyer's own
 * Supabase project, using a key set there as a secret. That is the right place
 * for it — the key never reaches the browser, never sits in a database row the
 * client can read, and never travels with a screenshot of the Settings screen —
 * but it does mean the app cannot show the trader what they configured. All it
 * can do is ask.
 *
 * So this asks. It sends `{ probe: true }`, which both functions answer before
 * touching the model, and turns the reply — or the failure — into the one thing
 * a Settings screen actually needs: which of the three setup steps is not done.
 */

/** The functions that need the key, and the names the trader sees. */
export const AGENT_FUNCTIONS = [
  { fn: 'dom-report', label: 'DOM' },
  { fn: 'finski-brief', label: 'Finski' },
]

export const SECRET_NAME = 'ANTHROPIC_API_KEY'

/**
 * States, in the order they are worth reporting.
 *
 * `unknown` is not a failure — it is what an unreachable network looks like,
 * and calling that "not set up" would send a trader off to re-paste a key that
 * was fine.
 */
export const SETUP_STATES = {
  READY: 'ready',
  NO_KEY: 'no-key',
  NOT_DEPLOYED: 'not-deployed',
  SIGNED_OUT: 'signed-out',
  UNKNOWN: 'unknown',
}

/**
 * Probes one function.
 *
 * @returns {Promise<{state: string, detail?: string}>}
 */
async function probeOne(fn) {
  try {
    const { data, error } = await supabase.functions.invoke(fn, { body: { probe: true } })

    if (error) {
      // The Edge runtime answers a call to a function that was never deployed
      // with a 404. That is a different problem from a missing key, and sending
      // someone to the secrets page to fix it would waste their afternoon.
      const status = error.context?.status
      const detail = await error.context?.json?.().catch(() => null)

      if (status === 404) return { state: SETUP_STATES.NOT_DEPLOYED }
      if (status === 401) return { state: SETUP_STATES.SIGNED_OUT }
      return { state: SETUP_STATES.UNKNOWN, detail: detail?.error ?? error.message }
    }

    return data?.keyConfigured
      ? { state: SETUP_STATES.READY }
      : { state: SETUP_STATES.NO_KEY }
  } catch (err) {
    return { state: SETUP_STATES.UNKNOWN, detail: err?.message }
  }
}

/**
 * The state of both functions, plus one overall verdict.
 *
 * The verdict is the *worst* of the two rather than an average: a journal where
 * DOM works and Finski was never deployed is not "half set up", it is a journal
 * with a broken button on it, and the screen has to say which.
 */
export async function checkAgentSetup() {
  const results = await Promise.all(
    AGENT_FUNCTIONS.map(async (agent) => ({ ...agent, ...(await probeOne(agent.fn)) }))
  )

  const order = [
    SETUP_STATES.SIGNED_OUT,
    SETUP_STATES.NOT_DEPLOYED,
    SETUP_STATES.NO_KEY,
    SETUP_STATES.UNKNOWN,
    SETUP_STATES.READY,
  ]

  const worst = order.find((state) => results.some((r) => r.state === state))

  return { state: worst ?? SETUP_STATES.UNKNOWN, agents: results }
}
