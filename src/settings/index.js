import { defineAgent } from '../agents/contract.js'
import { getConfig, saveConfig } from '../journal/settings.js'
import { FIELD_TYPES, THEMES, migrate } from '../domain/config.js'
import { statusList } from '../domain/trade-vocab.js'
import { PINNED_COLUMNS, availableColumns, tableColumns } from '../domain/table-columns.js'
import { HEADER_TILES, visibleTiles } from '../domain/header-tiles.js'
import { ARCHIVE_KEEP, ARCHIVE_THRESHOLD, archiveOldTrades, countTrades } from '../journal/trades.js'
import { MAX_BYTES, WARN_BYTES, formatBytes } from '../journal/screenshots.js'
import { presetPreview } from './preset-preview.js'
import { renderInfo } from '../onboarding/info.js'
import { SECRET_NAME, SETUP_STATES, checkAgentSetup } from '../agents/setup.js'
import {
  MAX_STRATEGIES,
  addField,
  addStrategy,
  applyPreset,
  bucketBounds,
  clearConfig,
  deleteField,
  deleteStrategy,
  fieldsLostWith,
  moveColumn,
  moveField,
  renameStrategy,
  setBuckets,
  setCurrency,
  setOptions,
  restartOnboarding,
  setStatuses,
  toggleColumn,
  toggleTile,
  updateField,
} from '../domain/config-edit.js'
import { PRESETS, findPreset } from '../domain/presets.js'
import { CURRENCY_MAX, applyCurrency, applyTheme } from '../lib/display.js'
import { esc, explainFailure } from '../lib/ui-text.js'

/**
 * Settings — where the buyer's journal becomes theirs.
 *
 * Every screen in this app renders whatever config holds; this is the one that
 * writes it. Nothing here knows what a setup or a target is, only that a field
 * has a name, a type and a place to appear.
 *
 * One rule runs through all of it, and the copy on screen says so out loud:
 * **renaming is free, deleting is not.** Ids are what trades store (§4.2), so a
 * label edit is cosmetic and a delete is the only action that can cost you a
 * breakdown you were relying on.
 *
 * Saving is immediate and per-edit rather than a form with a Save button. The
 * config is small, every operation is a whole-object write, and a screen that
 * can be left half-saved is a screen that silently loses a field.
 */

const FIELD_TYPE_LABELS = {
  text: 'Text box',
  number: 'Number',
  select: 'Pick one',
  multiselect: 'Pick several',
  toggle: 'Yes / no',
}

/** What each type is *for*, in the one line the trader will actually read. */
const FIELD_TYPE_HINTS = {
  text: 'Anything you want to type. Never groups cleanly in the statistics.',
  number: 'A figure. Give it ranges below, or it is recorded but never grouped.',
  select: 'One value from a list you write. The cleanest thing to measure.',
  multiselect: 'Several values at once. Its rows add up to more than your trade count.',
  toggle: 'On or off. Only "on" is stored.',
}

const THEME_LABELS = { dark: 'Dark', light: 'Light' }

const panel = (title, body, note = '') => `
  <section class="panel set-panel">
    <h2 class="panel-title">${title}</h2>
    ${note ? `<p class="muted set-note">${note}</p>` : ''}
    ${body}
  </section>
`

const textInput = (act, value, placeholder = '', extra = '') =>
  `<input class="set-input" type="text" data-act="${act}" value="${esc(value ?? '')}"
          placeholder="${esc(placeholder)}"${extra}>`

// --- appearance -----------------------------------------------------------

const appearancePanel = (config) =>
  panel(
    'Appearance',
    `<div class="set-row">
      <div class="set-field">
        <span class="set-label">Theme</span>
        <div class="seg-group" role="radiogroup" aria-label="Theme">
          ${THEMES.map(
            (t) =>
              `<button type="button" class="seg${t === config.theme ? ' on' : ''}" role="radio"
                       aria-checked="${t === config.theme}" data-act="theme" data-val="${t}">
                 ${THEME_LABELS[t]}
               </button>`
          ).join('')}
        </div>
      </div>
      <label class="set-field">
        <span class="set-label">Currency</span>
        ${textInput('currency', config.currency, '$', ` maxlength="${CURRENCY_MAX}"`)}
        <span class="set-hint">
          A symbol, not a currency code — the journal never converts anything.
          Every P&amp;L reads <b>+${esc(config.currency)}1,463</b>. A single space means no symbol.
        </span>
      </label>
    </div>`,
    'Stored with the rest of your settings, so both follow you between devices.'
  )

// --- journal --------------------------------------------------------------

const journalPanel = (config) =>
  panel(
    'Journal',
    `<div class="set-row">
      <label class="set-field">
        <span class="set-label">Instrument</span>
        ${textInput('instrument', config.instrument, 'MNQ, ES, AAPL…')}
        <span class="set-hint">Shown on every trade as “MNQ #46”. Leave empty for “#46”.</span>
      </label>
      <label class="set-field">
        <span class="set-label">Session</span>
        ${textInput('session', config.session, '09:30–12:00 ET')}
        <span class="set-hint">Context for the pre-market brief. Not used in any calculation.</span>
      </label>
    </div>`
  )

const statusesPanel = (config) =>
  panel(
    'Statuses',
    `<label class="set-field">
      <span class="set-label">One per line, in the order the form offers them</span>
      <textarea class="set-textarea" rows="6" data-act="statuses">${esc(
        statusList(config).join('\n')
      )}</textarea>
      <span class="set-hint">
        Leave it empty to go back to the defaults. Retiring a status is safe:
        trades that closed under it keep saying so, and the statistics keep a row for them.
      </span>
    </label>`,
    'How a trade finished. “TP / SL / BE” is futures shorthand — if you close, ' +
      'scale or get stopped, say that instead.'
  )

// --- table ----------------------------------------------------------------

const columnRow = (col, selected, index, total) => {
  const on = selected.includes(col.id)
  const pinned = PINNED_COLUMNS.includes(col.id)

  return `
  <div class="set-item">
    <label class="set-toggle set-grow">
      <input type="checkbox" data-act="column" data-id="${esc(col.id)}"
             ${on ? 'checked' : ''}${pinned ? ' disabled' : ''}>
      <span>${esc(col.label)}</span>
      ${col.field ? '<span class="set-tag">your field</span>' : ''}
      ${pinned ? '<span class="set-tag">always shown</span>' : ''}
    </label>
    ${
      on
        ? `<button type="button" class="ghost icon set-move" data-act="col-left"
                   data-id="${esc(col.id)}" aria-label="Move left"${index === 0 ? ' disabled' : ''}>←</button>
           <button type="button" class="ghost icon set-move" data-act="col-right"
                   data-id="${esc(col.id)}" aria-label="Move right"${
                     index === total - 1 ? ' disabled' : ''
                   }>→</button>`
        : ''
    }
  </div>`
}

const tablePanel = (config) => {
  const selected = tableColumns(config).map((c) => c.id)
  const available = availableColumns(config)

  // Chosen columns first, in table order, then the rest — so the list reads
  // like the table it describes rather than like a catalogue.
  const ordered = [
    ...selected.map((id) => available.find((c) => c.id === id)).filter(Boolean),
    ...available.filter((c) => !selected.includes(c.id)),
  ]

  return panel(
    'Journal table',
    ordered
      .map((c) =>
        columnRow(c, selected, selected.indexOf(c.id), selected.length)
      )
      .join(''),
    'Which columns the trade table shows, left to right. Any field you have defined can ' +
      'be one — a field scoped to a single strategy simply sits empty on trades taken ' +
      'under another.'
  )
}

const tilesPanel = (config) => {
  const shown = visibleTiles(config).map((t) => t.id)

  return panel(
    'Header tiles',
    HEADER_TILES.map(
      (tile) => `
      <div class="set-item">
        <label class="set-toggle set-grow">
          <input type="checkbox" data-act="tile" data-id="${esc(tile.id)}"
                 ${shown.includes(tile.id) ? 'checked' : ''}>
          <span>${esc(tile.label)}</span>
        </label>
        <span class="set-hint set-tile-why">${esc(tile.why)}</span>
      </div>`
    ).join(''),
    'The strip of numbers above the trade table. They always cover every trade on the ' +
      'selected account — including archived ones — never just what the filters show.'
  )
}

// --- agents and the API key -----------------------------------------------

const CONSOLE_URL = 'https://console.anthropic.com/settings/keys'

/**
 * What the trader is told, per state.
 *
 * `unknown` deliberately does not read as a failure. It is what an unreachable
 * network looks like, and telling someone their setup is broken when their wifi
 * dropped sends them off to re-paste a key that was fine.
 */
const SETUP_COPY = {
  [SETUP_STATES.READY]: ['ok', 'Ready', 'Both agents can reach Anthropic.'],
  [SETUP_STATES.NO_KEY]: [
    'warn',
    'No key set',
    'The functions are deployed, but no ' + SECRET_NAME + ' secret was found. Step 2 below.',
  ],
  [SETUP_STATES.NOT_DEPLOYED]: [
    'warn',
    'Not deployed',
    'The Edge Functions are not on this project yet. Step 1 below — the key comes after.',
  ],
  [SETUP_STATES.SIGNED_OUT]: ['warn', 'Signed out', 'The check could not authenticate.'],
  [SETUP_STATES.UNKNOWN]: [
    'neu',
    'Could not check',
    'No answer from the project. Usually the network rather than your setup.',
  ],
}

const CLI_LINES = [
  'supabase functions deploy dom-report',
  'supabase functions deploy finski-brief',
  'supabase secrets set ' + SECRET_NAME + '=sk-ant-…',
]

const stepBlock = (n, title, body) => `
  <div class="key-step">
    <span class="key-num">${n}</span>
    <div>
      <b class="key-title">${title}</b>
      ${body}
    </div>
  </div>`

/**
 * There is no box to paste a key into, and that is the point.
 *
 * The key lives as a secret inside the trader's own Supabase project, where the
 * Edge Functions read it and the browser never sees it. A field on this screen
 * would put it in a database row the client can read, in the page's memory, and
 * in any screenshot of this panel — for the convenience of not opening one other
 * tab. So the screen guides and verifies instead: it can tell you exactly which
 * step is undone, which is the part that is actually hard.
 */
const keyPanel = (setup, checking) => {
  const [tone, label, note] = SETUP_COPY[setup?.state] ?? SETUP_COPY[SETUP_STATES.UNKNOWN]

  return panel(
    'Agents &amp; API key',
    `<div class="set-detail-foot key-status">
      <span>
        <b class="key-badge key-${tone}">${checking ? 'Checking…' : esc(label)}</b>
        <span class="set-hint">${esc(note)}</span>
      </span>
      <button type="button" class="ghost" data-act="check-key" ${checking ? 'disabled' : ''}>
        ${checking ? 'Checking…' : 'Check again'}
      </button>
    </div>

    ${
      setup?.agents?.length
        ? `<div class="key-agents">
             ${setup.agents
               .map((a) => {
                 const [t, l] = SETUP_COPY[a.state] ?? SETUP_COPY[SETUP_STATES.UNKNOWN]
                 return `<span class="key-agent"><b>${esc(a.label)}</b>
                           <span class="key-badge key-${t}">${esc(l)}</span></span>`
               })
               .join('')}
           </div>`
        : ''
    }

    ${stepBlock(
      1,
      'Deploy the two functions',
      `<p class="set-hint">
         Once, from the folder this app came in. They are what call Anthropic; without them
         the DOM and Finski pages have nothing to talk to.
       </p>`
    )}

    ${stepBlock(
      2,
      'Get a key from Anthropic',
      `<p class="set-hint">
         <a href="${CONSOLE_URL}" target="_blank" rel="noopener">console.anthropic.com</a>
         → API keys → Create key. It begins <code>sk-ant-</code>. You pay Anthropic directly
         for what the agents use; nothing routes through anyone else.
       </p>`
    )}

    ${stepBlock(
      3,
      'Set it as a project secret',
      `<p class="set-hint">
         In the Supabase dashboard: <b>Project Settings → Edge Functions → Secrets</b>, name it
         exactly <code>${SECRET_NAME}</code>. Or run the third line below.
       </p>`
    )}

    <div class="key-cli">
      <pre class="key-pre">${CLI_LINES.map(esc).join('\n')}</pre>
      <button type="button" class="ghost" data-act="copy-cli">Copy</button>
    </div>

    <p class="set-hint key-note">
      <b>There is no box here to paste the key into, deliberately.</b> It stays in your
      Supabase project, where the functions read it server-side — never in this app, never in
      your browser, never in a screenshot of this screen. What this panel can do is tell you
      which step is not done, which is the part that is actually fiddly.
    </p>`,
    'DOM and Finski call Anthropic through your own Supabase project, on your own key. ' +
      'The journal itself needs none of this — every number in it is computed locally.'
  )
}

// --- data -----------------------------------------------------------------

/**
 * Where a trader can see how much they have accumulated, and do something
 * about it.
 *
 * The counts are a live query rather than a stored figure, because the whole
 * point of the panel is to be trusted about size. `counts` is null until it
 * arrives; the panel renders a placeholder rather than a zero, since "0 trades"
 * would be a lie for the second it was on screen.
 */
const dataPanel = (counts) =>
  panel(
    'Data',
    `<div class="set-row">
      <div class="set-field">
        <span class="set-label">In the journal</span>
        <b class="set-count">${counts ? counts.active : '—'}</b>
        <span class="set-hint">Listed in the trade table by default.</span>
      </div>
      <div class="set-field">
        <span class="set-label">Archived</span>
        <b class="set-count">${counts ? counts.archived : '—'}</b>
        <span class="set-hint">Out of the list, still counted in every figure.</span>
      </div>
      <div class="set-field">
        <span class="set-label">Total</span>
        <b class="set-count">${counts ? counts.total : '—'}</b>
        <span class="set-hint">What the statistics page reports on.</span>
      </div>
    </div>

    <div class="set-detail-foot">
      <span class="set-hint">
        The journal offers to archive once <b>${ARCHIVE_THRESHOLD}</b> trades are in the
        working list, keeping the newest <b>${ARCHIVE_KEEP}</b>. Nothing is deleted, and any
        archived trade can be restored by opening it.
      </span>
      <button type="button" class="ghost" data-act="archive-now"
              ${counts && counts.active > ARCHIVE_KEEP ? '' : 'disabled'}>
        Archive now
      </button>
    </div>

    <p class="set-hint set-storage">
      <b>Screenshots are stored inside the trade itself.</b> Each one is compressed to
      about ${formatBytes(MAX_BYTES)} or less, and the form marks any over
      ${formatBytes(WARN_BYTES)} as large. A thousand trades with a screenshot each is
      roughly ${formatBytes(MAX_BYTES * 1000)} of database — worth knowing before you
      pick a Supabase plan.
    </p>`,
    'How much this journal holds, and what to do when it gets long.'
  )

// --- strategies -----------------------------------------------------------

const strategyRow = (s, config) => {
  const lost = fieldsLostWith(config, s.id).length

  return `
  <div class="set-item" data-strategy="${esc(s.id)}">
    <input class="set-input set-grow" type="text" data-act="rename-strategy"
           data-id="${esc(s.id)}" value="${esc(s.label)}">
    <span class="set-id mono">${esc(s.id)}</span>
    <button type="button" class="ghost danger set-x" data-act="delete-strategy"
            data-id="${esc(s.id)}" data-lost="${lost}"
            title="Delete this strategy">Delete</button>
  </div>`
}

const strategiesPanel = (config) => {
  const room = config.strategies.length < MAX_STRATEGIES

  return panel(
    'Strategies',
    `${
      config.strategies.length
        ? config.strategies.map((s) => strategyRow(s, config)).join('')
        : '<p class="muted">None yet. Every trade is logged as untagged, which is a valid journal.</p>'
    }
    ${
      room
        ? `<div class="set-item set-add">
             ${textInput('new-strategy', '', 'New strategy name…', ' data-enter="add-strategy"')}
             <button type="button" class="ghost" data-act="add-strategy">Add strategy</button>
           </div>`
        : `<p class="muted">${MAX_STRATEGIES} is the maximum.</p>`
    }`,
    'Rename freely — trades store a hidden id, so a rename never moves a trade. ' +
      'With one strategy the form stops asking and just uses it.'
  )
}

// --- fields ---------------------------------------------------------------

const scopeOptions = (config, selected) =>
  [
    `<option value=""${selected ? '' : ' selected'}>Every trade</option>`,
    ...config.strategies.map(
      (s) =>
        `<option value="${esc(s.id)}"${s.id === selected ? ' selected' : ''}>Only ${esc(s.label)}</option>`
    ),
  ].join('')

/**
 * The expanded editor for one field.
 *
 * Options and ranges are textareas rather than a row of inputs with an add
 * button: a trader pasting eleven setups from a note should not have to click
 * eleven times, and one text box is also the only control that makes reordering
 * obvious.
 */
const fieldDetail = (field, config) => {
  const listy = field.type === 'select' || field.type === 'multiselect'

  return `
  <div class="set-detail">
    <div class="set-row">
      <label class="set-field">
        <span class="set-label">Type</span>
        <select class="set-select" data-act="field-type" data-id="${esc(field.id)}">
          ${FIELD_TYPES.map(
            (t) =>
              `<option value="${t}"${t === field.type ? ' selected' : ''}>${FIELD_TYPE_LABELS[t]}</option>`
          ).join('')}
        </select>
        <span class="set-hint">${esc(FIELD_TYPE_HINTS[field.type])}</span>
      </label>

      <label class="set-field">
        <span class="set-label">Shown on</span>
        <select class="set-select" data-act="field-scope" data-id="${esc(field.id)}">
          ${scopeOptions(config, field.strategy)}
        </select>
        <span class="set-hint">A field can belong to one strategy, the way a setup list does.</span>
      </label>
    </div>

    ${
      listy
        ? `<label class="set-field">
             <span class="set-label">Choices — one per line</span>
             <textarea class="set-textarea" rows="5" data-act="field-options"
                       data-id="${esc(field.id)}">${esc((field.options ?? []).join('\n'))}</textarea>
             <span class="set-hint">
               Removing a choice is safe: trades that answered it keep showing it in the statistics.
             </span>
           </label>
           <label class="set-toggle">
             <input type="checkbox" data-act="field-allow-custom" data-id="${esc(field.id)}"
                    ${field.allow_custom ? 'checked' : ''}>
             <span>Let me type something not on the list</span>
           </label>`
        : ''
    }

    ${
      field.type === 'number'
        ? `<label class="set-field">
             <span class="set-label">Group into ranges — upper bounds, comma separated</span>
             ${textInput('field-buckets', bucketBounds(field), 'e.g. 10, 30', ` data-id="${esc(field.id)}"`)}
             <span class="set-hint">
               ${
                 field.buckets?.length
                   ? `Groups as ${field.buckets.map((b) => esc(b.label)).join(' · ')}.`
                   : 'Empty means this is recorded but never grouped — right for a price, ' +
                     'wrong for anything you want a breakdown of.'
               }
             </span>
           </label>`
        : ''
    }

    <div class="set-detail-foot">
      <span class="set-id mono">id ${esc(field.id)}</span>
      <button type="button" class="ghost danger" data-act="delete-field"
              data-id="${esc(field.id)}" data-label="${esc(field.label)}">Delete field</button>
    </div>
  </div>`
}

const fieldRow = (field, config, open) => `
  <div class="set-item-block${open ? ' open' : ''}" data-field="${esc(field.id)}">
    <div class="set-item">
      <button type="button" class="ghost icon set-move" data-act="move-up"
              data-id="${esc(field.id)}" aria-label="Move up">↑</button>
      <button type="button" class="ghost icon set-move" data-act="move-down"
              data-id="${esc(field.id)}" aria-label="Move down">↓</button>
      <input class="set-input set-grow" type="text" data-act="rename-field"
             data-id="${esc(field.id)}" value="${esc(field.label)}">
      <span class="set-tag">${FIELD_TYPE_LABELS[field.type]}</span>
      ${
        field.strategy
          ? `<span class="set-tag set-tag-scope">${esc(
              config.strategies.find((s) => s.id === field.strategy)?.label ?? field.strategy
            )}</span>`
          : ''
      }
      <button type="button" class="ghost" data-act="toggle-field" data-id="${esc(field.id)}">
        ${open ? 'Done' : 'Edit'}
      </button>
    </div>
    ${open ? fieldDetail(field, config) : ''}
  </div>`

const fieldsPanel = (config, openId) =>
  panel(
    'Fields',
    `${
      config.custom_fields.length
        ? config.custom_fields.map((f) => fieldRow(f, config, f.id === openId)).join('')
        : `<p class="muted">No fields yet. The form still logs direction, date, status, P&amp;L,
             risk, thesis, hindsight and a screenshot — those are built in. Everything else
             is up to you.</p>`
    }
    <div class="set-item set-add">
      ${textInput('new-field', '', 'New field name…', ' data-enter="add-field"')}
      <button type="button" class="ghost" data-act="add-field">Add field</button>
    </div>`,
    'These are the questions your log form asks, and every one becomes its own breakdown ' +
      'on the Statistics page. Renaming is free. Deleting removes the field from the form; ' +
      'answers already recorded stay in your trades and keep appearing in the statistics.'
  )

// --- presets --------------------------------------------------------------

const presetCard = (preset, open) => `
  <div class="set-preset${open ? ' open' : ''}">
    <div class="set-preset-head">
      <b>${esc(preset.name)}</b>
      <span class="set-preset-actions">
        <button type="button" class="ghost" data-act="preview-preset" data-id="${esc(preset.id)}">
          ${open ? 'Hide' : 'Preview'}
        </button>
        <button type="button" class="ghost" data-act="apply-preset" data-id="${esc(preset.id)}"
                data-name="${esc(preset.name)}">Use this</button>
      </span>
    </div>
    <p class="set-preset-sum">${esc(preset.summary)}</p>
    <p class="muted set-preset-detail">${esc(preset.detail)}</p>
    <p class="set-preset-fields">
      ${(preset.config.strategies ?? []).length} strateg${
        (preset.config.strategies ?? []).length === 1 ? 'y' : 'ies'
      } ·
      ${(preset.config.custom_fields ?? []).length} fields:
      <span class="muted">${esc(
        (preset.config.custom_fields ?? []).map((f) => f.label).join(', ')
      )}</span>
    </p>
    ${open ? presetPreview(preset) : ''}
  </div>
`

const presetsPanel = (openPreset) =>
  panel(
    'Start from a preset',
    `<div class="set-presets${openPreset ? ' previewing' : ''}">
       ${PRESETS.map((p) => presetCard(p, p.id === openPreset)).join('')}
     </div>
     <div class="set-detail-foot">
       <span class="muted">Or begin with nothing at all.</span>
       <button type="button" class="ghost danger" data-act="clear">Clear everything</button>
     </div>`,
    'A preset replaces your strategies and fields — it does not merge with them. ' +
      'Your trades are never touched, and everything a preset defines can be renamed, ' +
      'retyped or deleted afterwards.'
  )

// --- info -----------------------------------------------------------------

const infoPanel = () =>
  panel(
    'Walkthrough',
    `<div class="set-detail-foot">
       <span class="set-hint">
         The three-screen introduction shown on a first sign-in. Running it again will not
         undo anything you have set up — it starts from your current settings, and skipping
         it changes nothing.
       </span>
       <button type="button" class="ghost" data-act="restart-onboarding">Run it again</button>
     </div>`,
    'Everything below is reference: the things worth knowing that a walkthrough has no ' +
      'room for.'
  ) + renderInfo()

const TABS = [
  { id: 'setup', label: 'Setup' },
  { id: 'info', label: 'Info & onboarding' },
]

const tabBar = (active) => `
  <div class="set-tabs" role="tablist">
    ${TABS.map(
      (t) =>
        `<button type="button" class="set-tab${t.id === active ? ' on' : ''}" role="tab"
                 aria-selected="${t.id === active}" data-act="tab" data-id="${t.id}">
           ${esc(t.label)}
         </button>`
    ).join('')}
  </div>`

// --- the view -------------------------------------------------------------

export const settings = defineAgent({
  id: 'settings',
  title: 'Settings',
  pageTitle: 'Settings',
  subtitle: 'Make the journal describe how you actually trade',

  async mount(el, { navigate } = {}) {
    el.innerHTML = `<p class="muted">Loading settings…</p>`

    let config = await getConfig({ refresh: true })
    /** Which field's editor is expanded. One at a time — this is a long list. */
    let openField = null
    /** Which preset is showing its preview. Also one at a time. */
    let openPreset = null
    /** Trade counts for the Data panel. Null until the query lands. */
    let counts = null
    /** Agent setup, from the probe. Null until it answers. */
    let setup = null
    let checkingKey = false
    /** Which tab is open. Not remembered between visits — Setup is the reason
     *  people come here, and landing on the reference would be in the way. */
    let tab = 'setup'

    const paint = () => {
      el.innerHTML = `
        <div class="settings">
          ${tabBar(tab)}
          <p class="err set-err" id="set-err"></p>
          ${
            tab === 'info'
              ? infoPanel()
              : `
          ${appearancePanel(config)}
          ${journalPanel(config)}
          ${statusesPanel(config)}
          ${strategiesPanel(config)}
          ${fieldsPanel(config, openField)}
          ${tablePanel(config)}
          ${tilesPanel(config)}
          ${keyPanel(setup, checkingKey)}
          ${dataPanel(counts)}
          ${presetsPanel(openPreset)}`
          }
        </div>
      `
    }

    const setError = (message) => {
      const box = el.querySelector('#set-err')
      if (box) box.textContent = message
    }

    /**
     * Writes a new config and repaints.
     *
     * The screen paints from what came back from `saveConfig`, not from what it
     * sent: `migrate` runs on the way in, so a field it normalised differently
     * would otherwise show one thing here and behave as another everywhere else.
     */
    const commit = async (next, { repaint = true } = {}) => {
      try {
        config = await saveConfig(next)
        if (repaint) paint()
        setError('')
      } catch (err) {
        setError(explainFailure(err, { prefix: 'Could not save' }))
      }
      return config
    }

    /** An edit that must not steal focus back from the box being typed in. */
    const commitQuietly = (next) => commit(next, { repaint: false })

    paint()

    /**
     * Counts arrive after the first paint rather than blocking it: they are two
     * `head: true` queries, and a settings screen that waits on the network to
     * show a theme switch is a settings screen that feels broken.
     */
    const refreshCounts = () =>
      countTrades()
        .then((next) => {
          counts = next
          paint()
        })
        .catch(() => {
          /* The panel keeps its placeholders; nothing else on the screen needs them. */
        })

    refreshCounts()

    /**
     * Probes the Edge Functions. Two network calls, so it runs after the first
     * paint and never blocks it — and it is re-run on demand rather than on a
     * timer, because nothing about this changes unless the trader changes it.
     */
    const refreshSetup = async () => {
      checkingKey = true
      paint()
      try {
        setup = await checkAgentSetup()
      } catch {
        setup = null
      }
      checkingKey = false
      paint()
    }

    refreshSetup()

    // --- clicks ---------------------------------------------------------
    el.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-act]')
      if (!button || button.tagName === 'INPUT' || button.tagName === 'SELECT') return
      const { act, id } = button.dataset

      try {
        switch (act) {
          case 'theme': {
            // Applied before the write, so the change is instant even if the
            // save is slow — and it is re-applied from what saved, below.
            applyTheme(button.dataset.val)
            const saved = await commit(migrate({ ...config, theme: button.dataset.val }))
            applyTheme(saved.theme)
            return
          }

          case 'add-strategy': {
            const box = el.querySelector('[data-act="new-strategy"]')
            await commit(addStrategy(config, box.value))
            return
          }

          case 'delete-strategy': {
            const lost = Number(button.dataset.lost) || 0
            const warning = lost
              ? `\n\n${lost} field${lost === 1 ? '' : 's'} scoped to it will be removed too.`
              : ''
            if (
              !confirm(
                `Delete this strategy?${warning}\n\n` +
                  'Trades already tagged with it keep their tag and their answers — ' +
                  'the statistics will show its id instead of a name.'
              )
            ) {
              return
            }
            await commit(deleteStrategy(config, id))
            return
          }

          case 'add-field': {
            const box = el.querySelector('[data-act="new-field"]')
            const before = new Set(config.custom_fields.map((f) => f.id))
            const saved = await commit(addField(config, { label: box.value }))
            // Open the new field straight away: a field with no type and no
            // choices set is not finished, and this is where that is done.
            openField = saved.custom_fields.find((f) => !before.has(f.id))?.id ?? null
            paint()
            return
          }

          case 'toggle-field':
            openField = openField === id ? null : id
            paint()
            return

          case 'tab':
            tab = id
            paint()
            return

          case 'restart-onboarding':
            await commit(restartOnboarding(config))
            // The walkthrough lives in the journal, so send them there rather
            // than leaving a button that appears to have done nothing.
            navigate?.('journal')
            return

          case 'preview-preset':
            openPreset = openPreset === id ? null : id
            paint()
            return

          case 'check-key':
            await refreshSetup()
            return

          case 'copy-cli':
            try {
              await navigator.clipboard.writeText(CLI_LINES.join('\n'))
              button.textContent = 'Copied'
              setTimeout(() => {
                button.textContent = 'Copy'
              }, 1500)
            } catch {
              // Clipboard access can be refused; the commands are on screen and
              // selectable either way, so this is a convenience, not a feature.
              setError('Could not reach the clipboard — select the commands instead')
            }
            return

          case 'archive-now': {
            const moving = (counts?.active ?? 0) - ARCHIVE_KEEP
            if (
              moving <= 0 ||
              !confirm(
                `Archive the oldest ${moving} trades?\n\n` +
                  `The newest ${ARCHIVE_KEEP} stay in the journal list. Nothing is deleted, ` +
                  'every figure still counts them, and any of them can be restored by ' +
                  'opening it from the Archived view.'
              )
            ) {
              return
            }
            button.disabled = true
            button.textContent = 'Archiving…'
            try {
              await archiveOldTrades()
              await refreshCounts()
            } catch (err) {
              setError(explainFailure(err, { prefix: 'Could not archive' }))
              paint()
            }
            return
          }

          case 'col-left':
            await commit(moveColumn(config, id, -1))
            return

          case 'col-right':
            await commit(moveColumn(config, id, 1))
            return

          case 'move-up':
            await commit(moveField(config, id, -1))
            return

          case 'move-down':
            await commit(moveField(config, id, 1))
            return

          case 'delete-field': {
            if (
              !confirm(
                `Delete “${button.dataset.label}”?\n\n` +
                  'It disappears from the log form. Answers already recorded stay in your ' +
                  'trades and keep appearing in the statistics — but adding the field back ' +
                  'later creates a new one, and it will not pick those answers up again.'
              )
            ) {
              return
            }
            if (openField === id) openField = null
            await commit(deleteField(config, id))
            return
          }

          case 'apply-preset': {
            if (
              !confirm(
                `Use the ${button.dataset.name} preset?\n\n` +
                  'This replaces your strategies and fields. Your trades are not touched, ' +
                  'and answers they already carry stay with them.'
              )
            ) {
              return
            }
            openField = null
            openPreset = null
            await commit(applyPreset(config, findPreset(id)))
            return
          }

          case 'clear': {
            if (
              !confirm(
                'Clear every strategy and field?\n\n' +
                  'Your trades are not touched. The log form falls back to the built-in ' +
                  'columns only.'
              )
            ) {
              return
            }
            openField = null
            await commit(clearConfig(config))
            return
          }
        }
      } catch (err) {
        setError(err.message ?? 'That did not work')
      }
    })

    // --- typing ---------------------------------------------------------
    // Committed on `change` (blur or Enter), not on every keystroke: this is a
    // network write per edit, and one per character would be a write storm.
    el.addEventListener('change', async (event) => {
      const input = event.target.closest('[data-act]')
      if (!input) return
      const { act, id } = input.dataset

      try {
        switch (act) {
          case 'instrument':
            await commitQuietly(migrate({ ...config, instrument: input.value.trim() || null }))
            return
          case 'session':
            await commitQuietly(migrate({ ...config, session: input.value.trim() || null }))
            return
          case 'currency': {
            // Applied before the write for the same reason as the theme: the
            // hint beside the box shows the symbol, and a lag there reads as a
            // rejected edit.
            const saved = await commit(setCurrency(config, input.value))
            applyCurrency(saved.currency)
            return
          }
          case 'statuses':
            // Repaints: an empty box falls back to the defaults, and the box has
            // to show what was actually stored.
            await commit(setStatuses(config, input.value))
            return
          case 'column':
            await commit(toggleColumn(config, id, input.checked))
            return
          case 'tile':
            await commit(toggleTile(config, id, input.checked))
            return
          case 'rename-strategy':
            await commitQuietly(renameStrategy(config, id, input.value))
            return
          case 'rename-field':
            await commitQuietly(updateField(config, id, { label: input.value }))
            return
          case 'field-type':
            // Repaints: the detail panel shows different controls per type.
            await commit(updateField(config, id, { type: input.value }))
            return
          case 'field-scope':
            await commit(updateField(config, id, { strategy: input.value || null }))
            return
          case 'field-options':
            await commitQuietly(setOptions(config, id, input.value))
            return
          case 'field-allow-custom':
            await commitQuietly(updateField(config, id, { allow_custom: input.checked }))
            return
          case 'field-buckets':
            // Repaints so the hint can show the ranges it just produced.
            await commit(setBuckets(config, id, input.value))
            return
        }
      } catch (err) {
        setError(err.message ?? 'That did not work')
        paint()
      }
    })

    // Enter in an "add" box does what the button beside it does.
    el.addEventListener('keydown', (event) => {
      const act = event.target.dataset?.enter
      if (!act || event.key !== 'Enter') return
      event.preventDefault()
      el.querySelector(`button[data-act="${act}"]`)?.click()
    })
  },
})
