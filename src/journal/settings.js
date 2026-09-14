import { supabase } from '../lib/supabase.js'
import { getUser } from '../lib/auth.js'
import { BLANK_CONFIG, SCHEMA_VERSION, loadConfig } from '../domain/config.js'

/**
 * Reads and writes the single `settings` row.
 *
 * Same shape as trades.js and accounts.js: cloud-first, RLS scopes rows to the
 * signed-in user so no query filters on user_id, and the insert still sets it
 * because the column is not null and the insert policy checks it.
 *
 * There is exactly one row per user, holding one jsonb `config` column. Adding
 * a setting is a write to that blob, never a migration — ARCHITECTURE.md, rule 1.
 */

let cached = null

/**
 * The user's config, or a blank one.
 *
 * A missing row is the normal first-run state, not an error: the wizard has not
 * run yet. A *failed read* is also answered with a blank config rather than a
 * throw, because a journal that cannot reach its settings should still let the
 * trader log a trade — they just get the untagged form.
 */
export async function getConfig({ refresh = false } = {}) {
  if (cached && !refresh) return cached

  try {
    const { data, error } = await supabase
      .from('settings')
      .select('id, config')
      .maybeSingle()

    if (error) throw error
    cached = loadConfig(data)
  } catch {
    cached = { ...BLANK_CONFIG }
  }

  return cached
}

/**
 * Writes the whole config back.
 *
 * Upsert on the fixed primary key: the table is constrained to `id = 1`, so
 * there is no way to create a second settings row by racing this call.
 */
export async function saveConfig(config) {
  const user = await getUser()
  if (!user) throw new Error('Not signed in')

  const next = { ...config, schema_version: SCHEMA_VERSION }

  const { data, error } = await supabase
    .from('settings')
    .upsert({ id: 1, user_id: user.id, config: next }, { onConflict: 'id' })
    .select('id, config')
    .single()

  if (error) throw error
  cached = loadConfig(data)
  return cached
}

/** Drops the cache so the next read hits the database. */
export function invalidateConfig() {
  cached = null
}
