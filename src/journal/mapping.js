/**
 * Row mapping for the `trades` table — the single place column names appear.
 *
 * Seventeen columns, and that is the whole schema. The rule for what earns one
 * (ARCHITECTURE.md, rule 1) is not "is this field important" but "does the app's own
 * code compute with it generically?" — money, R's denominator, the keys the
 * database itself has to enforce or order by. Everything that describes *how
 * the trader trades* — setups, tags, targets, prices, conviction — lives in
 * `custom`, defined from Settings, and adding one is a write, never a
 * migration.
 *
 * Column types:
 *   id          text     client-generated, not a uuid or serial
 *   user_id     uuid
 *   updated_at  bigint   epoch MILLISECONDS — see assertEpochMs below
 *   num         integer  display counter, not unique
 *   date        text     datetime-local string, NOT a date type
 *   direction   text     'Long' | 'Short'
 *   status      text     null on a veto, which has no fill to describe
 *   pnl, risk   numeric  default 0, not null
 *   kind        text     'trade' | 'veto'; null on pre-veto rows = trade
 *   account_id  uuid     FK to accounts(id) on delete set null; null = unassigned
 *   strategy    text     a strategy id from config ('model_a'…); null = untagged
 *   thesis      text
 *   hindsight   text
 *   image       text     base64 data URL
 *   custom      jsonb    user-defined fields, keyed by generated field id (§4.2)
 *   archived    boolean  out of the working list; still in every statistic
 *
 * `strategy` and `custom` are the generic seam: the journal stores which
 * strategy a trade belongs to and whatever else the trader chose to record, and
 * knows nothing about what any of it means. Per §4.2 the *id* is stored, never
 * the label, so renaming a strategy or a field leaves historical trades intact.
 */

/**
 * Trade ids are generated client-side — the column is text with no database
 * default, so a row written without an id fails.
 *
 * Base36 timestamp prefix, so ids sort by creation at millisecond granularity,
 * plus a wide random suffix from a CSPRNG. `id` is the upsert conflict key, so
 * a collision would silently overwrite an existing trade; a narrow random tail
 * collides measurably once several ids are minted inside the same millisecond,
 * which a bulk import does.
 */
export function uid() {
  const r = crypto.getRandomValues(new Uint32Array(2))
  return (
    Date.now().toString(36) +
    r[0].toString(36).padStart(7, '0') +
    r[1].toString(36).padStart(7, '0')
  )
}

/**
 * `date` is a text column, and the trade list orders by it lexicographically.
 * That matches chronological order only while every value keeps the exact
 * `YYYY-MM-DDTHH:mm` shape — which is also what an
 * `<input type="datetime-local">` produces and accepts.
 */
export function toDatetimeLocal(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

export function isValidTradeDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)
}

/**
 * Returns a copy stamped with the current time. Every write must go through
 * this: a trade read via fromRow carries the *stored* updatedAt, and writing
 * that value back unchanged leaves the row looking untouched to a
 * last-write-wins merge, which would then overwrite the edit with a stale copy.
 */
export function stampNow(trade) {
  return { ...trade, updatedAt: Date.now() }
}

/**
 * `updated_at` is the last-write-wins merge key, read as
 * `Number(r.updated_at) || 0`. A Postgres timestamp string would parse to NaN
 * there, collapse to 0, and make every cloud row look stale — silently
 * overwriting good trades on the next sync.
 *
 * So: integer milliseconds, always. Never a Date, never an ISO string.
 */
function assertEpochMs(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(
      `updated_at must be epoch milliseconds (integer), got ${JSON.stringify(value)}. ` +
        'Writing a timestamp here corrupts the last-write-wins merge.'
    )
  }
  return value
}

/**
 * User-defined field values, keyed by the generated field id from
 * `config.custom_fields` (§4.2). Always an object: a null jsonb column and an
 * unanswered form are the same thing to every reader.
 */
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

/** App trade object -> DB row. */
export function toRow(t, userId) {
  if (!userId) throw new Error('toRow requires the signed-in user id')
  return {
    id: t.id,
    user_id: userId,
    num: t.num ?? null,
    date: t.date ?? null,
    direction: t.direction ?? null,
    status: t.status ?? null,
    pnl: t.pnl ?? 0,
    risk: t.risk ?? 0,
    // Null is written as null rather than as 'trade': every row logged before
    // vetoes existed has null here, and stamping 'trade' on new rows only would
    // make the column look half-migrated. Readers resolve null themselves.
    kind: t.kind ?? null,
    // Null is a real value here, not a missing one: it means the trade is not
    // assigned to any account, which is what every trade logged before accounts
    // existed is. Empty string would violate the uuid column.
    account_id: t.account_id || null,
    // A strategy id from config, never a label. Null is a real value: it means
    // the trade is not assigned to a strategy, which every trade logged before
    // the trader defined one is.
    strategy: t.strategy ?? null,
    thesis: t.thesis ?? null,
    hindsight: t.hindsight ?? null,
    image: t.image ?? null,
    custom: obj(t.custom),
    archived: !!t.archived,
    updated_at: assertEpochMs(t.updatedAt ?? Date.now()),
  }
}

/** DB row -> app trade object. */
export function fromRow(r) {
  return {
    id: r.id,
    num: r.num,
    date: r.date,
    direction: r.direction,
    status: r.status,
    // Postgres returns numerics as strings and every aggregate in the product
    // does arithmetic on these two. Unmapped, '250' + '120' is '250120'.
    pnl: Number(r.pnl) || 0,
    risk: Number(r.risk) || 0,
    kind: r.kind || null,
    account_id: r.account_id || null,
    strategy: r.strategy || null,
    thesis: r.thesis || '',
    hindsight: r.hindsight || '',
    image: r.image || null,
    custom: obj(r.custom),
    archived: !!r.archived,
    updatedAt: Number(r.updated_at) || 0,
  }
}
