/**
 * Guest preview — a local, in-memory stand-in for Supabase.
 *
 * Exists so the UI can be opened and clicked through without a Supabase project,
 * an account, or a network. Nothing here talks to anything: rows live in a plain
 * object for the life of the tab.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THIS IS A LOGIN BYPASS AND MUST NEVER REACH A BUYER.                      │
 * │                                                                          │
 * │ `GUEST_ENABLED` is `import.meta.env.DEV`, which Vite replaces with the    │
 * │ literal `false` in every production build. Every branch below then folds  │
 * │ to dead code and is dropped by the minifier — verified by grepping the    │
 * │ built bundle for the seed strings, which is a test in guest.test.js.      │
 * │                                                                          │
 * │ Do not make this reachable through an env var, a query string, or a       │
 * │ config flag. A runtime switch is a runtime switch on a buyer's machine.   │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

/** True only under `vite dev`. Vite inlines this as `false` when building. */
export const GUEST_ENABLED = import.meta.env.DEV

const ACTIVE_KEY = 'guest_preview_active'

/** Survives a reload so the preview does not log itself out on every edit. */
export function isGuestActive() {
  if (!GUEST_ENABLED) return false
  try {
    return sessionStorage.getItem(ACTIVE_KEY) === '1'
  } catch {
    return false
  }
}

export function setGuestActive(on) {
  if (!GUEST_ENABLED) return
  try {
    if (on) sessionStorage.setItem(ACTIVE_KEY, '1')
    else sessionStorage.removeItem(ACTIVE_KEY)
  } catch {
    /* private mode: guest mode just will not survive the reload */
  }
}

const GUEST_USER = { id: '00000000-0000-0000-0000-00000000g457', email: 'guest@preview.local' }

/**
 * Seed data: none.
 *
 * The preview is a *fresh install* — no trades, no accounts, no settings row —
 * because that is the state every buyer meets on their first sign-in, and it is
 * the state hardest to check any other way. Sample data would make the journal
 * look finished while hiding the first hour of using it: an empty table, a form
 * that asks nothing but the built-in columns, and a Settings screen that has to
 * explain itself with nothing on it to point at.
 *
 * A missing settings row is not an error — `getConfig` answers it with a blank
 * config, which is exactly what a new account has. Applying a preset from
 * Settings writes the row, so the whole configure-then-log path is walkable
 * here. It lives for the tab: `createGuestClient` re-seeds on every page load,
 * so a reload is how you get back to a fresh install.
 */
function seed() {
  return {
    trades: [],
    accounts: [],
    settings: [],
    finski_briefs: [],
    dom_reports: [],
  }
}

let db = null
const tableOf = (name) => (db[name] ??= [])

/**
 * A thenable query builder covering the slice of the Supabase client this app
 * uses: select/insert/upsert/update/delete, eq/in/is/order/limit/range, exact
 * counts, single and maybeSingle. Awaiting it resolves `{ data, error }`, as the
 * real client does.
 *
 * The semantics that matter are the ones where a naive fake would differ from
 * the real thing in a way the app would not notice until production:
 *
 *   update  patches every row the filters matched, and inserts nothing. A fake
 *           that keyed the payload by `id` would quietly create a bogus row for
 *           `update({archived:true}).in('id', […])`, which carries no id.
 *   order   is a list, applied in the order it was called, because the trade
 *           list orders by date and then by id to break ties — and a single
 *           slot would silently make the tie-break the only sort.
 *   range   is what paging is built on; without it every read stops at one page.
 */
function query(table) {
  const state = {
    op: 'select',
    rows: null,
    patch: null,
    filters: [],
    order: [],
    limit: null,
    range: null,
    count: null,
    head: false,
    mode: null,
  }

  const compare = (a, b, col, asc) => {
    const x = a[col]
    const y = b[col]
    if (x === y) return 0
    // Numbers compare numerically, everything else as text — `num` is an
    // integer column the app orders on, and '10' sorts before '9' as a string.
    const result =
      typeof x === 'number' && typeof y === 'number'
        ? x - y
        : String(x ?? '').localeCompare(String(y ?? ''))
    return result * (asc ? 1 : -1)
  }

  const run = () => {
    let rows = [...tableOf(table)]
    for (const [col, test] of state.filters) rows = rows.filter((r) => test(r[col]))

    if (state.op === 'delete') {
      const going = new Set(rows.map((r) => r.id))
      db[table] = tableOf(table).filter((r) => !going.has(r.id))
      return { data: null, error: null }
    }

    if (state.op === 'update') {
      // Patch in place, matching Postgres: an update touches what the filters
      // selected and creates nothing.
      rows = rows.map((row) => {
        const i = tableOf(table).findIndex((r) => r.id === row.id)
        tableOf(table)[i] = { ...tableOf(table)[i], ...state.patch }
        return tableOf(table)[i]
      })
    }

    if (state.op === 'insert' || state.op === 'upsert') {
      for (const row of state.rows) {
        const i = tableOf(table).findIndex((r) => r.id === row.id)
        if (i >= 0 && state.op === 'upsert') tableOf(table)[i] = { ...tableOf(table)[i], ...row }
        else if (i < 0) tableOf(table).push({ ...row })
      }
      rows = state.rows.map((row) => tableOf(table).find((r) => r.id === row.id) ?? row)
    }

    for (const { col, asc } of [...state.order].reverse()) {
      rows.sort((a, b) => compare(a, b, col, asc))
    }

    // Counted before paging, like the real thing: `count` is how many matched,
    // not how many came back.
    const total = rows.length

    if (state.range) rows = rows.slice(state.range.from, state.range.to + 1)
    if (state.limit != null) rows = rows.slice(0, state.limit)

    if (state.head) return { data: null, count: total, error: null }

    if (state.mode === 'single') {
      // The real client errors when single() matches nothing; callers rely on it.
      if (!rows.length) return { data: null, error: { message: 'No rows found' } }
      return { data: rows[0], count: total, error: null }
    }
    if (state.mode === 'maybeSingle') return { data: rows[0] ?? null, count: total, error: null }

    return { data: rows, count: state.count ? total : null, error: null }
  }

  const builder = {
    select(_columns, opts = {}) {
      state.count = opts.count ?? null
      state.head = !!opts.head
      return builder
    },
    order(col, opts = {}) {
      state.order.push({ col, asc: opts.ascending !== false })
      return builder
    },
    limit(n) { state.limit = n; return builder },
    range(from, to) { state.range = { from, to }; return builder },
    eq(col, val) { state.filters.push([col, (v) => v === val]); return builder },
    // Postgres reads a missing boolean column as null; the app stores `false`.
    // Both have to answer `is('archived', false)`, or a guest journal created
    // before the column existed would vanish from the list.
    is(col, val) {
      state.filters.push([col, (v) => (val === null ? v === null || v === undefined : v === val)])
      return builder
    },
    in(col, vals) { state.filters.push([col, (v) => vals.includes(v)]); return builder },
    single() { state.mode = 'single'; return builder },
    maybeSingle() { state.mode = 'maybeSingle'; return builder },
    insert(rows) { state.op = 'insert'; state.rows = [].concat(rows); return builder },
    upsert(rows) { state.op = 'upsert'; state.rows = [].concat(rows); return builder },
    update(patch) { state.op = 'update'; state.patch = patch; return builder },
    delete() { state.op = 'delete'; return builder },
    then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject) },
  }

  return builder
}

/** A stand-in exposing only what src/lib/auth.js and the data modules call. */
export function createGuestClient() {
  db = seed()
  const listeners = new Set()
  const session = { user: GUEST_USER }

  return {
    from: (table) => query(table),
    auth: {
      getSession: async () => ({ data: { session: isGuestActive() ? session : null }, error: null }),
      getUser: async () => ({ data: { user: isGuestActive() ? GUEST_USER : null }, error: null }),
      signInWithPassword: async () => ({ data: { user: GUEST_USER }, error: null }),
      signOut: async () => {
        setGuestActive(false)
        listeners.forEach((fn) => fn('SIGNED_OUT', null))
        return { error: null }
      },
      onAuthStateChange: (handler) => {
        listeners.add(handler)
        // Mirrors the real client's INITIAL_SESSION, which the shell waits for.
        queueMicrotask(() => handler('INITIAL_SESSION', isGuestActive() ? session : null))
        return {
          data: {
            subscription: { unsubscribe: () => listeners.delete(handler) },
          },
        }
      },
      /** Not part of the real client. The guest button calls it to sign in. */
      __enterGuest: () => {
        setGuestActive(true)
        listeners.forEach((fn) => fn('SIGNED_IN', session))
      },
    },
  }
}
