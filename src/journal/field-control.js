/**
 * One user-defined field, rendered as the control the log form uses.
 *
 * Shared rather than private to the form, because the Settings screen previews
 * presets with it. A preview drawn from a second, "close enough" renderer is
 * worse than no preview: it would show a trader a form they are not going to
 * get, and drift a little further every time either side is touched. This way
 * the preview is the form, with its wiring removed.
 *
 * `inert` is that removal. It drops the `data-*` hooks the form reads answers
 * back through and disables every control, so a preview cannot be typed into,
 * cannot be harvested, and cannot be mistaken for a live field.
 */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const options = (values, selected) =>
  values.map((v) => `<option${v === selected ? ' selected' : ''}>${esc(v)}</option>`).join('')

/**
 * @param {object} field a `customField`
 * @param {*} value the current answer; a Set for a multiselect
 * @param {{inert?: boolean}} [opts] inert renders a disabled, unwired copy
 */
export function fieldControl(field, value, { inert = false } = {}) {
  const label = `<span class="tag-label">${esc(field.label)}</span>`
  const off = inert ? ' disabled' : ''
  // The hook the form's `harvest` finds controls by. A preview has none, which
  // is what makes it impossible to read a preview back as an answer.
  const input = inert ? '' : ` data-field-input="${esc(field.id)}"`

  switch (field.type) {
    case 'toggle':
      return `
        <label class="tag-toggle" data-field="${esc(field.id)}">
          <input type="checkbox"${input}${value ? ' checked' : ''}${off}>
          <span class="tswitch"></span>${esc(field.label)}
        </label>`

    case 'number':
      return `
        <label class="tag-group" data-field="${esc(field.id)}">
          ${label}
          <input class="tag-input" type="number" step="any"${input}
                 value="${esc(value ?? '')}"${off}>
        </label>`

    case 'select':
      return `
        <label class="tag-group" data-field="${esc(field.id)}">
          ${label}
          ${
            field.allow_custom
              ? `<input class="tag-input" type="text" list="dl-${esc(field.id)}"${input}
                        value="${esc(value ?? '')}"${off}>
                 ${inert ? '' : `<datalist id="dl-${esc(field.id)}">${options(field.options)}</datalist>`}`
              : `<select class="tag-select"${input}${off}>
                   <option value="">—</option>${options(field.options, value ?? '')}
                 </select>`
          }
        </label>`

    case 'multiselect': {
      const chosen = value instanceof Set ? value : new Set()
      // Options first, in the order config lists them, then anything chosen
      // that is not among them — a hand-typed level, or an option deleted since.
      const all = [...field.options, ...[...chosen].filter((v) => !field.options.includes(v))]
      const multi = inert ? '' : ` data-multi="${esc(field.id)}"`

      return `
        <div class="tag-group" data-field="${esc(field.id)}">
          ${label}
          <div class="pill-row">
            ${
              all.length
                ? all
                    .map(
                      (v) =>
                        `<button type="button" class="pill${chosen.has(v) ? ' on' : ''}"${multi}
                                 data-val="${esc(v)}"${off}>${esc(v)}</button>`
                    )
                    .join('')
                : '<span class="muted-tag">None defined</span>'
            }
          </div>
          ${
            field.allow_custom
              ? `<input class="tag-input" type="text" placeholder="add…"${
                  inert ? '' : ` data-field-add="${esc(field.id)}"`
                }${off}>`
              : ''
          }
        </div>`
    }

    default:
      return `
        <label class="tag-group" data-field="${esc(field.id)}">
          ${label}
          <input class="tag-input" type="text"${input} value="${esc(value ?? '')}"${off}>
        </label>`
  }
}
