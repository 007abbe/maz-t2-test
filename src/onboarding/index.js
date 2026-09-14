import { PRESETS, findPreset } from '../domain/presets.js'
import { THEMES, migrate } from '../domain/config.js'
import { applyPreset, clearConfig, completeOnboarding, setCurrency } from '../domain/config-edit.js'
import { saveConfig } from '../journal/settings.js'
import { applyCurrency, applyTheme } from '../lib/display.js'
import { presetPreview } from '../settings/preset-preview.js'
import { SECRET_NAME } from '../agents/setup.js'
import { esc, explainFailure } from '../lib/ui-text.js'

/**
 * First run.
 *
 * A buyer signing in for the first time meets an empty table, and an empty
 * table explains nothing: not that the columns are fixed and the rest is
 * theirs, not that presets exist, not that Settings is where the journal
 * becomes theirs. This is the ten seconds that says so.
 *
 * Three screens, because the decision it exists to serve — *what should this
 * journal ask me about a trade?* — is one screen; the other two are context
 * before it and cleanup after.
 *
 * It renders inside the journal view rather than over it. A modal on first
 * sign-in traps someone who just wants to look around, and the nav being
 * visible behind this is itself part of the explanation.
 *
 * **Skipping is a real answer.** Every screen offers it, and taking it marks
 * the trader onboarded exactly as finishing does — someone who chose to start
 * blank has decided, and greeting them again tomorrow turns a welcome into
 * nagging. Settings has a button to run it again.
 */

const STEPS = ['welcome', 'preset', 'basics', 'agents']

const CONSOLE_URL = 'https://console.anthropic.com/settings/keys'

const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'

const dots = (step) => `
  <div class="ob-dots" aria-hidden="true">
    ${STEPS.map((_, i) => `<span class="ob-dot${i === step ? ' on' : ''}"></span>`).join('')}
  </div>`

/**
 * What the journal records whatever the trader does — worth naming up front,
 * because the next screen is entirely about what it does *not* decide for them,
 * and that reads as "so what do I get?" without this.
 */
const BUILT_IN = [
  'Direction, date and status',
  'P&L and risk — every R in the app is one over the other',
  'The account it was taken on',
  'Your thesis, your hindsight note, a chart screenshot',
  'Trade or veto — an idea you passed on, kept out of every money figure',
]

const welcome = () => `
  <div class="ob-body">
    <h2 class="ob-title">This journal does not know how you trade.</h2>
    <p class="ob-lead">
      That is deliberate. Every trading journal that ships with someone else's setups
      quietly teaches you to trade like them. This one records the arithmetic — money,
      risk, R — and lets you write the rest of the vocabulary yourself.
    </p>

    <div class="ob-cols">
      <div>
        <h3 class="ob-h3">Always recorded</h3>
        <ul class="ob-list">
          ${BUILT_IN.map((line) => `<li>${esc(line)}</li>`).join('')}
        </ul>
      </div>
      <div>
        <h3 class="ob-h3">Entirely yours</h3>
        <p class="ob-note">
          Setups, tags, target levels, entry prices, conviction, mood — anything you
          want to measure is a <b>field</b> you define. Each one becomes its own
          breakdown on the Statistics page automatically.
        </p>
        <p class="ob-note">
          Rename a field whenever you like: your trades store a hidden id, so a rename
          never moves a trade between buckets.
        </p>
      </div>
    </div>
  </div>`

const presetStep = (chosen) => `
  <div class="ob-body">
    <h2 class="ob-title">Pick a starting point.</h2>
    <p class="ob-lead">
      None of these is the right way — they are three examples of the same machinery
      pointed at different styles of trading. Everything one defines can be renamed,
      retyped or deleted afterwards, and you can switch or clear later from Settings.
    </p>

    <div class="ob-presets">
      ${PRESETS.map(
        (preset) => `
        <label class="ob-preset${chosen === preset.id ? ' on' : ''}">
          <input type="radio" name="ob-preset" value="${esc(preset.id)}"
                 ${chosen === preset.id ? 'checked' : ''}>
          <b>${esc(preset.name)}</b>
          <span class="ob-preset-sum">${esc(preset.summary)}</span>
        </label>`
      ).join('')}
      <label class="ob-preset${chosen === 'blank' ? ' on' : ''}">
        <input type="radio" name="ob-preset" value="blank" ${chosen === 'blank' ? 'checked' : ''}>
        <b>Start blank</b>
        <span class="ob-preset-sum">No strategies, no fields. Add them as you learn what you keep typing.</span>
      </label>
    </div>

    ${
      chosen && chosen !== 'blank'
        ? `<div class="ob-preview-wrap">
             <h3 class="ob-h3">This is the form you would get</h3>
             ${presetPreview(findPreset(chosen))}
           </div>`
        : chosen === 'blank'
          ? `<p class="ob-note ob-preview-wrap">
               Your log form will ask only the things listed on the previous screen.
               Add fields in Settings whenever you know what you want to measure.
             </p>`
          : ''
    }
  </div>`

const basics = (draft) => `
  <div class="ob-body">
    <h2 class="ob-title">Two small things.</h2>
    <p class="ob-lead">Both are cosmetic, both are changeable, neither affects a number.</p>

    <div class="ob-cols">
      <label class="ob-field">
        <span class="ob-label">Instrument</span>
        <input class="set-input" type="text" id="ob-instrument" value="${esc(draft.instrument ?? '')}"
               placeholder="MNQ, ES, AAPL…">
        <span class="ob-hint">
          Trades read as “MNQ #46”. Leave it empty and they read “#46”.
        </span>
      </label>

      <label class="ob-field">
        <span class="ob-label">Currency</span>
        <input class="set-input" type="text" id="ob-currency" maxlength="4"
               value="${esc(draft.currency ?? '$')}" placeholder="$">
        <span class="ob-hint">
          A symbol, not a currency code — the journal never converts anything.
        </span>
      </label>
    </div>

    <div class="ob-theme">
      <span class="ob-label">Theme</span>
      <div class="seg-group" role="radiogroup" aria-label="Theme">
        ${THEMES.map(
          (t) =>
            `<button type="button" class="seg${draft.theme === t ? ' on' : ''}" role="radio"
                     aria-checked="${draft.theme === t}" data-act="theme" data-val="${t}">
               ${t === 'dark' ? 'Dark' : 'Light'}
             </button>`
        ).join('')}
      </div>
    </div>

    <p class="ob-note">
      Everything here, and everything on the last screen, lives in
      <b>Settings</b> — the gear at the bottom of the menu. Its
      <b>Info &amp; onboarding</b> tab explains the rest, and can replay this walkthrough.
    </p>
  </div>`

/**
 * The last screen: the one thing the journal cannot set up for you.
 *
 * Deliberately last, and deliberately framed as optional. DOM and Finski are
 * the only part of this product that needs anything beyond a Supabase project,
 * and someone logging their first trade tonight does not need an API key to do
 * it. Front-loading this would make a journal that works out of the box look
 * like one that does not.
 *
 * There is nothing to type here — the key is a secret in the trader's own
 * project, and this screen says so rather than pretending otherwise.
 */
const agentsStep = () => `
  <div class="ob-body">
    <h2 class="ob-title">Two agents, on your own key.</h2>
    <p class="ob-lead">
      Optional, and skippable — everything you have just set up works without them. The
      journal computes every number itself; these two only read what it has already
      computed.
    </p>

    <div class="ob-cols">
      <div>
        <h3 class="ob-h3">What they do</h3>
        <p class="ob-note">
          <b>DOM</b> reviews trades you select. Every figure in its report is computed here
          before the model sees it — it interprets numbers, it never calculates them, and the
          exact statistics it was given are stored beside the report.
        </p>
        <p class="ob-note">
          <b>Finski</b> writes a pre-market brief from volatility data, the day's calendar and
          your own note about yesterday. It is told never to predict direction.
        </p>
      </div>
      <div>
        <h3 class="ob-h3">What you need</h3>
        <ol class="ob-list ob-steps">
          <li>Deploy the two Edge Functions to your Supabase project.</li>
          <li>
            Create an API key at
            <a href="${CONSOLE_URL}" target="_blank" rel="noopener">console.anthropic.com</a>
            — it begins <code>sk-ant-</code>.
          </li>
          <li>
            Set it as a Supabase secret named <code>${SECRET_NAME}</code>.
          </li>
        </ol>
        <p class="ob-note">
          You pay Anthropic directly for what they use. The key stays in your project and
          never reaches this app or your browser — which is also why there is no box for it
          here.
        </p>
      </div>
    </div>

    <p class="ob-note">
      <b>Settings → Agents &amp; API key</b> has the same steps, the commands to copy, and a
      check that tells you which one is not done yet.
    </p>
  </div>`

/**
 * Renders the walkthrough into `el`.
 *
 * @param {HTMLElement} el
 * @param {object} config the current config, which the trader may already have
 *   edited — a walkthrough replayed from Settings must not present blank boxes
 *   over settings that exist.
 * @param {() => void} onDone called after the config is written, so the caller
 *   can re-render whatever it was showing.
 */
export function renderOnboarding(el, config, onDone) {
  let step = 0
  /** Held until "Finish": nothing is written while the trader is still deciding. */
  const draft = {
    preset: null,
    instrument: config.instrument ?? '',
    currency: config.currency ?? '$',
    theme: config.theme ?? 'dark',
  }

  const paint = () => {
    const last = step === STEPS.length - 1

    el.innerHTML = `
      <div class="onboarding">
        <header class="ob-head">
          <span class="ob-eyebrow">Getting started</span>
          <button type="button" class="ghost icon" data-act="skip" aria-label="Skip">
            ${CLOSE_ICON}
          </button>
        </header>

        ${[welcome, () => presetStep(draft.preset), () => basics(draft), agentsStep][step]()}

        <p class="err ob-err" id="ob-err"></p>

        <footer class="ob-foot">
          ${dots(step)}
          <span class="spacer"></span>
          <button type="button" class="ghost" data-act="skip">Skip for now</button>
          ${step > 0 ? '<button type="button" class="ghost" data-act="back">Back</button>' : ''}
          <button type="button" data-act="next" id="ob-next">
            ${last ? 'Finish' : step === 0 ? 'Get started' : 'Continue'}
          </button>
        </footer>
      </div>`
  }

  const setError = (message) => {
    const box = el.querySelector('#ob-err')
    if (box) box.textContent = message
  }

  /**
   * Copies the basics screen's boxes into the draft, if it is the one on
   * screen. Called before every move, so stepping forward and back does not
   * empty what the trader typed.
   */
  const harvestBasics = () => {
    const instrument = el.querySelector('#ob-instrument')
    const currency = el.querySelector('#ob-currency')
    if (instrument) draft.instrument = instrument.value
    if (currency) draft.currency = currency.value
  }

  /**
   * Writes everything at once, at the end.
   *
   * Applying the preset first and the basics over it, because a preset carries
   * its own instrument — the trader's answer on the last screen is the later
   * word and has to win.
   */
  async function finish(button) {
    button.disabled = true
    button.textContent = 'Setting up…'

    try {
      let next =
        draft.preset && draft.preset !== 'blank'
          ? applyPreset(config, findPreset(draft.preset))
          : draft.preset === 'blank'
            ? clearConfig(config)
            : migrate({ ...config })

      next = setCurrency(next, draft.currency)
      next = migrate({
        ...next,
        instrument: String(draft.instrument ?? '').trim() || null,
        theme: draft.theme,
      })

      const saved = await saveConfig(completeOnboarding(next))
      applyTheme(saved.theme)
      applyCurrency(saved.currency)
      onDone?.()
    } catch (err) {
      button.disabled = false
      button.textContent = 'Finish'
      setError(explainFailure(err, { prefix: 'Could not save your setup' }))
    }
  }

  /**
   * Skipping still writes, because "seen it, not now" is a decision worth
   * remembering.
   *
   * A failed write used to be swallowed here and `onDone` called anyway, on the
   * theory that a welcome screen must never trap anyone. It does trap them: the
   * re-render reads the same unsaved config, decides the walkthrough has not run
   * and draws it again — so the button looks broken rather than merely
   * unsuccessful. Now the failure is shown, and the walkthrough closes itself
   * regardless a moment later.
   */
  async function skip(button) {
    // The header's close button is an icon; relabelling it would replace the
    // cross with the word. Only the worded button reports progress.
    if (button && !button.classList.contains('icon')) {
      button.disabled = true
      button.textContent = 'Skipping…'
    }

    try {
      const saved = await saveConfig(completeOnboarding(config))
      applyTheme(saved.theme)
      applyCurrency(saved.currency)
      onDone?.()
    } catch (err) {
      console.error('[onboarding] could not save', err)
      setError(
        `${explainFailure(err, { prefix: 'Could not save that' })} — closing anyway; ` +
          'Settings can run this again.'
      )
      // Out of the way after the message has been readable for a moment. The
      // walkthrough is not worth trapping anyone in, but a button that appears
      // to do nothing is worse than a slow one.
      setTimeout(() => onDone?.(), 2500)
    }
  }

  /**
   * One delegated handler for the whole card.
   *
   * Wrapped, because an async listener that throws does it into a place nobody
   * is looking: the rejection is unhandled, the screen does not move, and the
   * button reads as dead. Any failure here now names itself on the card.
   */
  el.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-act]')
    if (!button) return

    try {
      switch (button.dataset.act) {
        case 'theme':
          draft.theme = button.dataset.val
          // Applied live: a theme you cannot see is not a choice you can make.
          applyTheme(draft.theme)
          return paint()

        case 'skip':
          return await skip(button)

        case 'back':
          harvestBasics()
          step = Math.max(0, step - 1)
          return paint()

        case 'next':
          // Harvested on the way out of whichever screen holds them, not at the
          // end: they live on the basics screen, which is no longer the last one,
          // and reading them from a screen that has been replaced returns null.
          harvestBasics()
          if (step < STEPS.length - 1) {
            step += 1
            return paint()
          }
          return await finish(button)
      }
    } catch (err) {
      console.error('[onboarding]', err)
      setError(err?.message ?? 'Something went wrong on this screen')
    }
  })

  el.addEventListener('change', (event) => {
    if (event.target.name !== 'ob-preset') return
    draft.preset = event.target.value
    paint()
  })

  paint()
}
