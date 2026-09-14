import { createClient } from '@supabase/supabase-js'
import { GUEST_ENABLED, isGuestActive, createGuestClient } from './guest.js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

/**
 * The guest preview replaces the client wholesale rather than being checked at
 * each call site, so no data module needs to know it exists.
 *
 * Opt-in, not automatic: `vite dev` against a real project behaves exactly as
 * production does until the guest button is pressed. That matters because a dev
 * mode that silently stubs the database is a dev mode you cannot test against.
 *
 * `GUEST_ENABLED` is `import.meta.env.DEV`, which Vite inlines as `false` when
 * building — so in a production bundle this is `if (false)` and both the branch
 * and the import fold away. See the header of guest.js.
 */
function client() {
  if (GUEST_ENABLED && isGuestActive()) return createGuestClient()

  if (!url || !anonKey) {
    throw new Error(
      'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill them in.'
    )
  }

  return createClient(url, anonKey)
}

export const supabase = client()
