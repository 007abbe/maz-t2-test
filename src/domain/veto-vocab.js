/**
 * What kind of row a journal entry is.
 *
 * One idea, one column. A veto has no fill, so it must be excluded from every
 * aggregate that has a dollar sign or a percent in it — which is why `kind` is
 * a column and not a user-defined field: it changes what the row *means* before
 * any money is summed.
 *
 * What a vetoed idea would have done, how convinced you were, whether a
 * mechanical reading of your rules agreed — all of that is vocabulary, and
 * belongs in `custom` where the trader can define it, rename it, or decide they
 * do not want to answer it. See src/domain/presets.js for an example set.
 *
 * Stored strings, so changing a value here means rewriting existing rows.
 */

/**
 * 'trade' — you took it. 'veto' — you did not, and this row is the record of
 * why.
 */
export const KINDS = ['trade', 'veto']

export const DEFAULT_KIND = 'trade'

/**
 * Null is a real answer here: every row written before `kind` existed is a
 * trade, because a veto was not something the form could log. Reading null as
 * 'trade' is what lets the migration stay additive.
 */
export const tradeKind = (t) => (t?.kind === 'veto' ? 'veto' : 'trade')

export const isVeto = (t) => tradeKind(t) === 'veto'

/** The complement, named so filters read as intent rather than as a negation. */
export const isRealTrade = (t) => !isVeto(t)
