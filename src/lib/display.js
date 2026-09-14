/**
 * Display preferences: the theme, and the currency P&L is written in.
 *
 * Both live in config, so they follow the trader between devices like the rest
 * of their setup. Both are also needed *before* the first paint, and config
 * arrives over the network — a journal that paints dark on its way to light, or
 * shows a column of `$` before settling on `kr`, looks broken rather than slow.
 *
 * So each is mirrored into localStorage and read back synchronously at startup.
 * localStorage is the **cache, never the source**: when config loads it wins,
 * even if it disagrees. A first sign-in on a new machine has no cache to be
 * right, and that is the case the mirror must not break.
 *
 * The currency is module state rather than a parameter threaded through every
 * caller. `fmtMoney` is called from six modules and inside template literals in
 * three more; passing a symbol to each would put a config lookup in code whose
 * whole job is formatting. It is set once, at boot, from the two places that
 * know: startup (cached) and the config load (authoritative).
 */

import { THEMES } from '../domain/config.js'

const THEME_KEY = 'mazevos.theme'
const CURRENCY_KEY = 'mazevos.currency'

export const DEFAULT_THEME = 'dark'
export const DEFAULT_CURRENCY = '$'

/** Long enough for "CHF", short enough that a paste cannot break the layout. */
export const CURRENCY_MAX = 4

const read = (key, fallback) => {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    // Private mode, or storage disabled. Preferences still apply for this
    // session; they just will not survive the reload, which is cosmetic.
    return fallback
  }
}

const write = (key, value) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* see read() */
  }
}

// --- theme ----------------------------------------------------------------

const validTheme = (theme) => (THEMES.includes(theme) ? theme : DEFAULT_THEME)

/**
 * Applies a theme to the document and remembers it for the next first paint.
 *
 * Writing the attribute is what changes the palette — every token in tokens.css
 * is redefined under `[data-theme="light"]`.
 */
export function applyTheme(theme) {
  const next = validTheme(theme)
  document.documentElement.dataset.theme = next
  write(THEME_KEY, next)
  return next
}

export const cachedTheme = () => validTheme(read(THEME_KEY, DEFAULT_THEME))

// --- currency -------------------------------------------------------------

/**
 * Trimmed, capped, and never empty.
 *
 * An empty symbol is a legitimate thing to want — some traders journal in R and
 * points and do not want a unit at all — but it cannot be the *stored* value,
 * because "" and "not set yet" would be the same thing to every reader. A
 * trader who wants no symbol sets a space.
 */
export const validCurrency = (symbol) => {
  const s = String(symbol ?? '').slice(0, CURRENCY_MAX)
  return s.trim() || s === ' ' ? s : DEFAULT_CURRENCY
}

let currency = DEFAULT_CURRENCY

export function applyCurrency(symbol) {
  currency = validCurrency(symbol)
  write(CURRENCY_KEY, currency)
  return currency
}

/** What `fmtMoney` prefixes every figure with. */
export const currencySymbol = () => currency

export const cachedCurrency = () => validCurrency(read(CURRENCY_KEY, DEFAULT_CURRENCY))

// --- startup and config ---------------------------------------------------

/** Applies the cached preferences immediately. Called once, before first paint. */
export function applyCached() {
  applyTheme(cachedTheme())
  applyCurrency(cachedCurrency())
}

/** Applies the stored preferences, which outrank the cache. */
export function applyFromConfig(config) {
  applyTheme(config?.theme)
  applyCurrency(config?.currency)
}
