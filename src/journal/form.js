import { DIRECTIONS, statusList } from '../domain/trade-vocab.js'
import { fieldsFor, buildCustom } from '../domain/config.js'
import { KINDS, tradeKind } from '../domain/veto-vocab.js'
import { backtestAccountIds } from '../domain/account-vocab.js'
import { SCOPES } from './filters.js'
import { upsertTrade, deleteTrade, getTrade, nextTradeNum, restoreTrade } from './trades.js'
import { listAccounts, lastUsedAccount, rememberLastUsedAccount } from './accounts.js'
import { toDatetimeLocal, isValidTradeDate } from './mapping.js'
import { getConfig } from './settings.js'
import { compressImage, dataUrlBytes, formatBytes, isImageFile, WARN_BYTES } from './screenshots.js'
import { fieldControl } from './field-control.js'

/**
 * The log/edit form.
 *
 * The top half is the columns — kind, direction, date, status, P&L, risk,
 * account, thesis, hindsight, screenshot — and it is the same for every buyer
 * because those are the things the app itself computes with.
 *
 * The bottom half is generated from `config.custom_fields`. Nothing in this
 * file names a setup, a tag or a price: it renders whatever the trader defined,
 * writes the answers into `custom` keyed by field id (§4.2), and has no opinion
 * about what any of them mean. A journal that has configured nothing shows the
 * top half alone, and that is a complete journal.
 */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const options = (values, selected) =>
  values.map((v) => `<option${v === selected ? ' selected' : ''}>${esc(v)}</option>`).join('')

const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'

/**
 * The panel of user-defined fields for whichever strategy the trade belongs to.
 *
 * Unscoped fields, then that strategy's own — so switching strategy grows or
 * shrinks a section at the bottom rather than rearranging the form. A journal
 * with no fields renders a prompt instead of an empty box, because an empty box
 * reads as something failing to load.
 */
function fieldPanel(config, strategyId, answers) {
  const fields = fieldsFor(config, strategyId)
  if (!fields.length) {
    return `<p class="muted">No fields defined. Add your own — setup, session, entry price,
      whatever you want to measure — in Settings, and they appear here.</p>`
  }

  return `<div class="tag-row">${fields.map((f) => fieldControl(f, answers[f.id])).join('')}</div>`
}

/**
 * The strategy selector, built from config.
 *
 * Three states, because a switch is only worth its space when there is a
 * decision behind it:
 *
 *   no strategies  — nothing at all; every trade is untagged, which is a valid
 *                    journal and the state a fresh install is in
 *   one strategy   — its name, and no control. There is nothing to choose, and
 *                    an "Untagged / Core" pair would invite the trader to file
 *                    trades under neither for no reason
 *   several        — the switch, including Untagged
 *
 * `data-strategy` carries the stored *id*, never the label — renaming a
 * strategy must not change what its trades are tagged with (§4.2).
 */
const strategySwitch = (config, strategyId) => {
  if (!config.strategies.length) return ''

  if (config.strategies.length === 1) {
    return `<span class="strategy-single">${esc(config.strategies[0].label)}</span>`
  }

  const seg = (id, label, on) =>
    `<button type="button" class="seg${on ? ' on' : ''}" role="radio" aria-checked="${on}" data-strategy="${esc(id)}">${esc(label)}</button>`

  return `
  <div class="model-switch" role="radiogroup" aria-label="Strategy">
    ${seg('', 'Untagged', !strategyId)}
    ${config.strategies.map((s) => seg(s.id, s.label, s.id === strategyId)).join('')}
  </div>`
}

/**
 * The strategy a form opens on.
 *
 * A journal with exactly one strategy assigns it rather than offering it — the
 * switch is hidden, so an untagged new trade would be untaggable. An existing
 * trade keeps whatever it was saved with, including null: re-tagging old trades
 * on open would rewrite history the first time each one is edited.
 */
function initialStrategy(full, config) {
  if (full.id) return full.strategy ?? null
  return config.strategies.length === 1 ? config.strategies[0].id : (full.strategy ?? null)
}

const KIND_LABELS = { trade: 'Trade', veto: 'Veto' }

/**
 * The first thing the form asks, because it changes what the rest of the form
 * even means: a trade you took has a P&L, a trade you passed on has an opinion.
 *
 * Rendered as a switch rather than a checkbox — "Veto" unticked would read as a
 * modifier on a trade, and it is not one. It is the other kind of row.
 */
const kindSwitch = (kind) => `
  <div class="full field kind-field">
    <div class="kind-switch" role="radiogroup" aria-label="Entry kind">
      ${KINDS.map(
        (k) =>
          `<button type="button" class="seg seg-${esc(k)}${k === kind ? ' on' : ''}" role="radio"
                   aria-checked="${k === kind}" data-kind="${esc(k)}">${esc(KIND_LABELS[k])}</button>`
      ).join('')}
    </div>
    <p class="kind-hint" id="kind-hint"></p>
  </div>`

const KIND_HINTS = {
  trade: 'A position you actually took. Counts toward P&L, win rate and trade count.',
  veto: 'An idea you passed on. No P&L, no win rate, no trade count — just the reasoning and whatever you record about it below.',
}

/**
 * The account this trade was taken on. Optional — every trade logged before
 * accounts existed has none, and "—" has to stay a legal answer or editing an
 * old trade would force one on it.
 *
 * `selected` is the trade's own account when editing, and the last account used
 * when logging a new one: the trader is almost always on the same account they
 * were on an hour ago, and a wrong default is one dropdown away from right.
 */
const accountField = (accounts, selected, scope) => {
  // In the Backtest journal "no account" is not an available answer. An
  // unassigned trade belongs to the live journal by definition (see byScope in
  // filters.js), so saving one here would file a simulated fill among real
  // ones — the exact leak the two journals exist to prevent.
  const backtest = scope === SCOPES.BACKTEST
  const blank = accounts.length
    ? backtest
      ? 'Pick a backtest account'
      : '—'
    : backtest
      ? 'No backtest accounts yet'
      : 'No accounts yet'

  return `
  <label>Account${backtest ? ' <span class="req">required</span>' : ''}
    <select id="f-account">
      <option value=""${selected ? '' : ' selected'}>${blank}</option>
      ${accounts
        .map(
          (a) =>
            `<option value="${esc(a.id)}"${a.id === selected ? ' selected' : ''}>${esc(a.name)}</option>`
        )
        .join('')}
    </select>
  </label>`
}

function template(trade, config, strategyId, accounts, account, scope) {
  const backtest = scope === SCOPES.BACKTEST
  const noun = backtest ? 'backtest entry' : 'trade'

  return `
  <div class="modal">
    <header class="modal-head">
      <h2>${trade.id ? 'Edit' : 'Log'} ${esc(noun)}${backtest ? ' <span class="badge acct-backtest">Backtest</span>' : ''}</h2>
      <button type="button" class="ghost icon" data-act="close" aria-label="Close">${CLOSE_ICON}</button>
    </header>

    <div class="modal-body">
      <div class="grid">
        ${kindSwitch(tradeKind(trade))}
        <label>Direction<select id="f-direction">${options(DIRECTIONS, trade.direction)}</select></label>
        <label>Date &amp; Time<input type="datetime-local" id="f-date" value="${esc(trade.date || toDatetimeLocal())}"></label>
        <label id="w-status">Status<select id="f-status">${options(statusList(config), trade.status)}</select></label>
        <label id="w-pnl">P&amp;L ($)<input type="number" id="f-pnl" step="0.01" placeholder="e.g. 250 or -120" value="${trade.pnl ?? ''}"></label>
        <label id="w-risk">Risk ($)<input type="number" id="f-risk" step="0.01" placeholder="Amount risked" value="${trade.risk ?? ''}"></label>
        ${accountField(accounts, account, scope)}

        <div class="tags">
          <div class="tags-head">
            <span>${config.strategies.length === 1 ? 'Strategy' : 'Strategy tags'}</span>
            ${strategySwitch(config, strategyId)}
          </div>
          <div class="tag-panel" id="tag-panel"></div>
        </div>

        <label class="full">Thesis<textarea id="f-thesis" placeholder="Why did you take this trade? What was the setup, flow, confluence...">${esc(trade.thesis ?? '')}</textarea></label>
        <label class="full">Hindsight notes<textarea id="f-hindsight" placeholder="Post-trade reflection. What worked, what didn't, what you missed...">${esc(trade.hindsight ?? '')}</textarea></label>

        <div class="full field">
          <span class="form-label">Screenshot</span>
          <div id="upload-wrap"></div>
          <input type="file" id="f-image" accept="image/*" hidden>
        </div>
      </div>

      <p class="err" id="form-err"></p>
    </div>

    <footer class="modal-foot">
      ${trade.id ? '<button type="button" class="ghost danger" data-act="delete">Delete</button>' : ''}
      ${
        // Only on an archived trade, and only here: the journal table has no
        // room for a per-row action, and this is already where a trade is
        // edited.
        trade.archived
          ? '<button type="button" class="ghost" data-act="restore">Restore to journal</button>'
          : ''
      }
      <span class="spacer"></span>
      <button type="button" class="ghost" data-act="close">Cancel</button>
      <button type="button" data-act="save" id="f-save">Save</button>
    </footer>
  </div>`
}

/**
 * Opens the add/edit modal. `trade` is a partial app-shaped trade; omit it to
 * create. Calls `onSaved()` after a successful save or delete.
 */
export async function openTradeForm({ trade = {}, onSaved, scope = SCOPES.LIVE } = {}) {
  // Editing needs the heavy fields the list query leaves out.
  const [full, allAccounts, config] = await Promise.all([
    trade.id ? getTrade(trade.id).then((t) => t ?? trade) : Promise.resolve(trade),
    // A failed account fetch must not block logging a trade: the field falls
    // back to an empty list, which renders as "No accounts yet".
    listAccounts().catch(() => []),
    // getConfig already answers a failed read with a blank config, so an
    // unreachable settings row costs the field panel, not the trade.
    getConfig(),
  ])

  // Only the accounts of the journal you are standing in. The dropdown is the
  // one place the two could be mixed, so it is the one place that has to filter
  // — and both directions matter: a live trade must not be filed to a backtest
  // account any more than the reverse.
  const backtestIds = backtestAccountIds(allAccounts)
  const wantBacktest = scope === SCOPES.BACKTEST
  const accounts = allAccounts.filter((a) => backtestIds.has(a.id) === wantBacktest)

  const accountIds = accounts.map((a) => a.id)
  const account = full.id ? (full.account_id ?? '') : lastUsedAccount(accountIds, scope)

  const state = {
    kind: tradeKind(full),
    // Null is a real value: the trade is not assigned to a strategy. A journal
    // that has defined none stays here permanently, and that is a valid journal.
    strategy: initialStrategy(full, config),
    image: full.image ?? null,
  }

  /**
   * Answers to user-defined fields, held outside the DOM so a strategy switch
   * cannot erase them — the panel is destroyed and rebuilt on every switch.
   *
   * Seeded from the *stored* custom object rather than from the field list, so
   * an answer to a field the trader has since rescoped survives an edit that
   * never re-renders it. Multi-value answers become Sets here and arrays again
   * on save.
   */
  const answers = {}
  for (const [id, value] of Object.entries(full.custom ?? {})) {
    answers[id] = Array.isArray(value) ? new Set(value) : value
  }
  // A multiselect the trade has never answered still needs a Set to toggle
  // into, and one created lazily on first click would not survive the harvest.
  for (const field of config.custom_fields ?? []) {
    if (field.type === 'multiselect' && !(answers[field.id] instanceof Set)) {
      answers[field.id] = new Set(
        Array.isArray(full.custom?.[field.id]) ? full.custom[field.id] : []
      )
    }
  }

  const overlay = document.createElement('div')
  overlay.className = 'overlay'
  overlay.innerHTML = template(full, config, state.strategy, accounts, account, scope)
  document.body.append(overlay)

  const $ = (sel) => overlay.querySelector(sel)
  const err = $('#form-err')

  /**
   * Copies what is on screen into `answers`.
   *
   * Driven by `data-field-input` rather than by a list of ids, so it reads
   * whatever the panel happens to be showing. Fields the current strategy does
   * not render are simply absent from the query and keep their last value.
   * Multiselects are not read here — their pills write straight to the Set.
   */
  function harvest() {
    for (const el of overlay.querySelectorAll('[data-field-input]')) {
      const id = el.dataset.fieldInput
      answers[id] = el.type === 'checkbox' ? el.checked : el.value
    }
  }

  /** Re-renders the field panel for the current strategy and rebinds what it owns. */
  function renderPanel() {
    $('#tag-panel').innerHTML = fieldPanel(config, state.strategy, answers)

    for (const el of overlay.querySelectorAll('.seg[data-strategy]')) {
      const on = (el.dataset.strategy || null) === state.strategy
      el.classList.toggle('on', on)
      el.setAttribute('aria-checked', String(on))
    }

    // Enter commits a typed value on a free-entry multiselect. Without this the
    // form would submit-by-habit and the value would sit in the box unrecorded.
    for (const box of overlay.querySelectorAll('[data-field-add]')) {
      box.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        if (addValue(box.dataset.fieldAdd, box.value)) {
          box.value = ''
          harvest()
          renderPanel()
        }
      })
    }
  }

  /** Adds a free-typed value to a multiselect. Returns false for an empty box. */
  function addValue(fieldId, raw) {
    const v = String(raw ?? '').trim()
    if (!v) return false
    ;(answers[fieldId] ??= new Set()).add(v)
    return true
  }

  function setStrategy(strategy) {
    if (strategy === state.strategy) return
    harvest()
    state.strategy = strategy
    renderPanel()
  }

  /**
   * Shows the fields the current kind can honestly answer, and hides the rest.
   *
   * Toggles `hidden` rather than re-rendering: switching Trade → Veto → Trade
   * must not empty a P&L the trader already typed, and the field panel below is
   * shared by both kinds, so rebuilding the body would cost those answers too.
   */
  function applyKind() {
    const veto = state.kind === 'veto'

    // P&L, Risk and Status all describe a fill. A veto has none.
    for (const sel of ['#w-pnl', '#w-risk', '#w-status']) {
      $(sel).hidden = veto
    }

    $('#kind-hint').textContent = KIND_HINTS[state.kind]
    $('#f-save').textContent = veto ? 'Save veto' : 'Save trade'

    for (const el of overlay.querySelectorAll('.seg[data-kind]')) {
      const on = el.dataset.kind === state.kind
      el.classList.toggle('on', on)
      el.setAttribute('aria-checked', String(on))
    }

    overlay.querySelector('.modal').classList.toggle('is-veto', veto)
  }

  function setKind(kind) {
    if (kind === state.kind) return
    state.kind = kind
    applyKind()
  }

  function renderUpload() {
    const wrap = $('#upload-wrap')
    if (state.image) {
      const bytes = dataUrlBytes(state.image)
      // Screenshots are stored inside the row, so their size is the trader's to
      // see. Said once, beside the image, rather than as a scolding banner.
      const heavy =
        bytes > WARN_BYTES
          ? `<span class="upload-warn" title="Screenshots are stored inside the trade itself, so large ones add up across a journal.">large</span>`
          : ''
      wrap.innerHTML = `<div class="preview"><img src="${state.image}" alt="Chart screenshot"><button type="button" class="ghost icon" data-act="clear-image" aria-label="Remove">${CLOSE_ICON}</button><span class="muted">${formatBytes(bytes)}</span>${heavy}</div>`
    } else {
      wrap.innerHTML = `<button type="button" class="upload" data-act="pick-image"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>Click to upload, or paste a chart screenshot</button>`
    }
  }

  async function useImageFile(file) {
    if (!isImageFile(file)) return
    err.textContent = 'Compressing…'
    try {
      state.image = await compressImage(file)
      err.textContent = ''
      renderUpload()
    } catch (e) {
      err.textContent = `Could not read that image: ${e.message}`
    }
  }

  function close() {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('paste', onPaste)
  }

  function onKey(e) {
    if (e.key === 'Escape') close()
  }

  function onPaste(e) {
    const file = [...(e.clipboardData?.items ?? [])]
      .find((i) => i.type.startsWith('image/'))
      ?.getAsFile()
    if (file) useImageFile(file)
  }

  async function save(button) {
    button.disabled = true
    err.textContent = ''
    try {
      const date = $('#f-date').value
      // `date` is a text column and the list sorts on it lexicographically, so
      // an empty or malformed value would land the row in the wrong place.
      if (!isValidTradeDate(date)) {
        throw new Error('Pick a date and time for this trade')
      }

      const accountId = $('#f-account').value || null

      // See accountField: an unassigned row lands in the live journal, so in the
      // Backtest journal saving without an account would file a simulated fill
      // among real ones. Refused rather than silently redirected.
      if (scope === SCOPES.BACKTEST && !accountId) {
        throw new Error(
          accounts.length
            ? 'Pick a backtest account — a backtest entry with no account would show up in the live journal'
            : 'Create a backtest account first: Accounts → New account → Backtest'
        )
      }

      harvest()
      // A value left typed in a free-entry box but never committed with Enter
      // would otherwise be silently dropped on save.
      for (const box of overlay.querySelectorAll('[data-field-add]')) {
        addValue(box.dataset.fieldAdd, box.value)
      }

      // A veto has no fill, so it has no P&L, risk or status — and those are
      // zeroed here rather than merely hidden, so that flipping a mistyped trade
      // to a veto cannot leave a stale $250 on the row for the tiles to find.
      const veto = state.kind === 'veto'

      await upsertTrade({
        id: full.id,
        num: full.num ?? (await nextTradeNum()),
        date,
        direction: $('#f-direction').value,
        kind: state.kind,
        status: veto ? null : $('#f-status').value,
        pnl: veto ? 0 : parseFloat($('#f-pnl').value) || 0,
        risk: veto ? 0 : parseFloat($('#f-risk').value) || 0,
        thesis: $('#f-thesis').value.trim(),
        hindsight: $('#f-hindsight').value.trim(),
        image: state.image,
        // The strategy id, never its label — see mapping.js.
        strategy: state.strategy,
        account_id: accountId,
        // Only the fields this trade's strategy actually offers are written. An
        // answer to a field scoped to a different strategy is dropped rather
        // than stored invisibly, which is the same rule the old form applied to
        // a setup that no longer belonged to the selected strategy.
        custom: buildCustom(fieldsFor(config, state.strategy), answers),
      })
      // Only remembered once the save succeeded, and only when an account was
      // actually picked — clearing the field is not a new default.
      if (accountId) rememberLastUsedAccount(accountId, scope)
      close()
      onSaved?.()
    } catch (e) {
      err.textContent = e.message || 'Save failed'
      button.disabled = false
    }
  }

  overlay.addEventListener('click', async (e) => {
    if (e.target === overlay) return close()

    const kindSeg = e.target.closest('.seg[data-kind]')
    if (kindSeg) return setKind(kindSeg.dataset.kind)

    const seg = e.target.closest('.seg[data-strategy]')
    if (seg) return setStrategy(seg.dataset.strategy || null)

    // `data-multi` names the field id whose Set this pill belongs to, so every
    // multiselect the trader ever defines shares one implementation.
    const p = e.target.closest('.pill[data-multi]')
    if (p) {
      const set = (answers[p.dataset.multi] ??= new Set())
      set.has(p.dataset.val) ? set.delete(p.dataset.val) : set.add(p.dataset.val)
      p.classList.toggle('on', set.has(p.dataset.val))
      return
    }

    const act = e.target.closest('[data-act]')?.dataset.act
    if (act === 'close') close()
    else if (act === 'delete') {
      if (!confirm('Delete this trade? This cannot be undone.')) return
      await deleteTrade(full.id)
      close()
      onSaved?.()
    } else if (act === 'restore') {
      await restoreTrade(full.id)
      close()
      onSaved?.()
    } else if (act === 'save') save(e.target.closest('[data-act]'))
    else if (act === 'pick-image') $('#f-image').click()
    else if (act === 'clear-image') {
      state.image = null
      renderUpload()
    }
  })

  $('#f-image').addEventListener('change', (e) => useImageFile(e.target.files[0]))
  document.addEventListener('keydown', onKey)
  document.addEventListener('paste', onPaste)

  applyKind()
  renderPanel()
  renderUpload()
  $('#f-date').focus()
}
