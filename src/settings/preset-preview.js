import { fieldsFor, migrate } from '../domain/config.js'
import { fieldControl } from '../journal/field-control.js'
import { esc } from '../lib/ui-text.js'

/**
 * What the log form would look like under a preset.
 *
 * Drawn with the form's own `fieldControl`, inert — see field-control.js. A
 * preview built from a second, "close enough" renderer would show a trader a
 * form they are not going to get, and drift further apart every time either
 * side is touched.
 *
 * The built-in row is shown greyed above the fields, because the most common
 * question a preview has to answer is not "what does this add" but "what do I
 * get anyway" — a trader looking at Minimal's three text boxes needs to see
 * that P&L, risk and a screenshot are not among the things it left out.
 */
export function presetPreview(preset) {
  const config = migrate(preset.config)
  const strategies = config.strategies

  const block = (strategyId, heading) => {
    const fields = fieldsFor(config, strategyId)
    if (!fields.length) return ''
    return `
      ${heading ? `<div class="prev-strategy">${esc(heading)}</div>` : ''}
      <div class="tag-row prev-fields">
        ${fields.map((f) => fieldControl(f, undefined, { inert: true })).join('')}
      </div>`
  }

  return `
  <div class="set-preview">
    <div class="prev-builtin">
      <span>Kind</span><span>Direction</span><span>Date</span><span>Status</span>
      <span>P&amp;L</span><span>Risk</span><span>Account</span>
      <span>Thesis</span><span>Hindsight</span><span>Screenshot</span>
      <em>always there</em>
    </div>
    ${
      strategies.length
        ? strategies.map((s) => block(s.id, s.label)).join('') ||
          '<p class="muted">No fields — just the built-in ones above.</p>'
        : block(null, '') || '<p class="muted">No fields — just the built-in ones above.</p>'
    }
    ${
      strategies.length === 1
        ? `<p class="muted prev-note">One strategy, so the form shows
             “${esc(strategies[0].label)}” as a label and asks nothing.</p>`
        : strategies.length > 1
          ? `<p class="muted prev-note">${strategies.length} strategies, so the form offers a
               switch — and each shows its own fields.</p>`
          : ''
    }
  </div>`
}
