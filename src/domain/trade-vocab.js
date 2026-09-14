/**
 * Controlled vocabularies for the columns of a trade.
 *
 * Only the vocabularies that are true of *any* journal live here, and both of
 * them back an actual column. Anything that describes a particular way of
 * trading — which strategies exist, what their setups are called, which market
 * states get tagged — is configuration, not code: see src/domain/config.js, and
 * ARCHITECTURE.md rule 1 for why the line falls where it does.
 *
 * Agent-agnostic and UI-free: forms read their options from here, they do not
 * define them.
 */

export const DIRECTIONS = ['Long', 'Short']

/**
 * How a trade finished — the *default* list, and the one a fresh journal starts
 * with. Free text in the database, so this is what the form offers, never what
 * the column enforces.
 *
 * Editable from Settings, because "TP / SL / BE" is futures vocabulary: an
 * equities swing trader closes, scales or gets stopped, and forcing them to
 * call a take-profit "TP" is exactly the kind of borrowed language this rebuild
 * exists to remove. `statusList(config)` is what the app reads; this is only
 * where it starts.
 */
export const DEFAULT_STATUSES = ['Open', 'TP', 'SL', 'BE', 'TP1+BE']

/** The statuses this journal offers. Falls back rather than rendering none. */
export const statusList = (config) =>
  config?.statuses?.length ? config.statuses : DEFAULT_STATUSES
