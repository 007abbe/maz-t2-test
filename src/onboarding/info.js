import { ARCHIVE_KEEP, ARCHIVE_THRESHOLD } from '../journal/trades.js'
import { MAX_BYTES, WARN_BYTES, formatBytes } from '../journal/screenshots.js'
import { FIELD_TYPES } from '../domain/config.js'
import { SECRET_NAME } from '../agents/setup.js'
import { esc } from '../lib/ui-text.js'

/**
 * The reference half of onboarding: what the walkthrough does not have room to
 * say, kept somewhere it can be re-read six months in.
 *
 * Written to answer the questions that actually cost a trader something when
 * they get them wrong — what deleting a field does to history, why average R
 * covers fewer trades than the count beside it, what the agents can and cannot
 * be trusted to say. Not a feature tour: a feature tour is what a screenshot is
 * for, and nobody reads one twice.
 *
 * Numbers are imported rather than typed, so a threshold changed in code cannot
 * leave this page quietly lying about it.
 */

const FIELD_TYPE_INFO = {
  text: [
    'Text box',
    'Anything you can type. Nothing constrains it, and nothing groups cleanly — a ' +
      'hundred trades produce a hundred setups. Good for a first month, while you find ' +
      'out which words you keep reaching for.',
  ],
  number: [
    'Number',
    'A figure: a price, a delay, days held. Give it ranges (“10, 30”) and the statistics ' +
      'group it into bands. Without ranges it is recorded but never grouped, because one ' +
      'row per distinct price is a table as long as your journal.',
  ],
  select: [
    'Pick one',
    'One value from a list you write. The cleanest thing to measure — every trade lands ' +
      'in exactly one bucket, so the breakdown adds up to your trade count.',
  ],
  multiselect: [
    'Pick several',
    'Several values at once, like tags. Its rows deliberately add up to <i>more</i> than ' +
      'your trade count: a trade wearing two tags is counted in both. Never total that ' +
      'column and call it a number of trades.',
  ],
  toggle: [
    'Yes / no',
    'On or off. Only “on” is stored, because “off” is the state of every trade logged ' +
      'before you added the field — writing it would make “no” and “never asked” the ' +
      'same thing.',
  ],
}

const section = (title, body) => `
  <section class="info-block">
    <h3 class="info-title">${title}</h3>
    ${body}
  </section>`

const p = (text) => `<p class="info-p">${text}</p>`

export function renderInfo() {
  return `
  <div class="info">
    ${section(
      'How this journal is built',
      p(`Seventeen things are recorded on every trade whatever you do: the date, direction and
         status, P&amp;L and risk, the account, your thesis and hindsight, a screenshot, and
         whether it was a trade or a veto. Those are columns because the app does arithmetic
         with them — every R in the product is P&amp;L ÷ risk, and if risk could be renamed
         away, every average R would go quietly null while the reports kept their confident
         tone.`) +
        p(`Everything that describes <i>how you trade</i> — setups, tags, targets, entry
           prices, conviction, mood — is a <b>field</b> you define. Adding one is a setting,
           never an update. You should never need a new version of this app to record
           something new about a trade.`)
    )}

    ${section(
      'The five kinds of field',
      `<dl class="info-dl">
        ${FIELD_TYPES.map((type) => {
          const [label, why] = FIELD_TYPE_INFO[type]
          return `<dt>${esc(label)}</dt><dd>${why}</dd>`
        }).join('')}
      </dl>` +
        p(`Every field you define becomes its own panel on the <b>Statistics</b> page, and can
           be a column in the trade table. A field can also belong to a single strategy — that
           is how one strategy gets its own setup list without the other seeing it.`)
    )}

    ${section(
      'Renaming is free. Deleting is not.',
      p(`Your trades store a hidden id for every strategy and every field, never the name. So
         renaming anything is cosmetic: a heading changes and not one trade moves between
         buckets. Rename as often as you like.`) +
        p(`Deleting a field removes it from the log form, but the answers stay on the trades
         that gave them, and the statistics keep reporting them — history you collected does
         not vanish because you stopped collecting it. What you cannot do is get it back:
         adding the field again creates a <i>new</i> field, and the old answers stay attached
         to the old one.`) +
        p(`Removing one <i>choice</i> from a list is always safe. Trades that answered it keep
         showing it.`)
    )}

    ${section(
      'What the numbers mean',
      `<dl class="info-dl">
        <dt>R</dt>
        <dd>P&amp;L ÷ risk, always. A trade logged without a risk has no R at all — it is left
          out of the average rather than counted as zero, which is why <b>Avg R</b> can rest on
          fewer trades than the count beside it. The statistics say how many.</dd>
        <dt>Win rate</dt>
        <dd>Share of closed trades that made money. It says nothing about how much, which is
          why it sits next to profit factor and not instead of it.</dd>
        <dt>Profit factor</dt>
        <dd>Gross wins ÷ gross losses. Above 1 is profitable. Null rather than infinity when
          there are no losses yet — an infinite profit factor is a small sample, not an edge.</dd>
        <dt>Vetoes</dt>
        <dd>Ideas you passed on. They have no fill, so they are removed before P&amp;L, win rate
          and trade count are computed — a journal that punished you for logging near-misses
          would teach you to stop logging them. They are counted on their own tile.</dd>
        <dt>Backtest accounts</dt>
        <dd>Held out of every live figure. A simulated fill was never real, and blending the
          two is how a backtest quietly becomes your track record.</dd>
      </dl>`
    )}

    ${section(
      'When the journal gets long',
      p(`Past <b>${ARCHIVE_THRESHOLD}</b> trades in the working list, the journal offers to
         archive — the newest <b>${ARCHIVE_KEEP}</b> stay in the table and the rest move to the
         Archived view. Nothing is deleted, and any archived trade can be restored by opening
         it.`) +
        p(`Archiving changes what is <i>listed</i> and nothing else. Every tile, every
         statistic and every account total still counts archived trades — otherwise “Net
         P&amp;L” would quietly turn into “P&amp;L since the last archive”, which is worse than
         a long table.`)
    )}

    ${section(
      'Screenshots and storage',
      p(`A screenshot is stored inside the trade itself, so it travels with the row and there
         is no second place for it to go missing. Each one is compressed to about
         ${formatBytes(MAX_BYTES)} or less; the form marks anything over
         ${formatBytes(WARN_BYTES)} as large. A thousand trades with a screenshot each is
         roughly ${formatBytes(MAX_BYTES * 1000)} of database — worth knowing before you pick
         a Supabase plan. Settings → Data keeps the running count.`)
    )}

    ${section(
      'DOM and Finski',
      p(`<b>DOM</b> reviews trades you select. Every number in its report is computed by this
         app before the model sees it — the model interprets figures and never calculates its
         own. That is the whole point of the split: a report can be audited against the exact
         statistics it was written from, which are stored alongside it.`) +
        p(`<b>Finski</b> writes a pre-market brief from volatility data, the day's economic
         calendar and your own note about yesterday. It is told never to predict direction.`) +
        p(`Neither knows what your strategies <i>are</i>. They are given your strategy names and
         nothing else, and are explicitly forbidden from guessing at the rules behind them.`) +
        p(`Both call Anthropic through your own Supabase project, using an API key you create at
         <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>
         and set as a Supabase secret named <code>${SECRET_NAME}</code>. You pay Anthropic
         directly for what they use; nothing routes through anyone else.`) +
        p(`The key stays in your project and is read server-side, so it never reaches this app
         or your browser — which is why there is no field for it in Settings. What Settings
         does have, under <b>Agents &amp; API key</b>, is the steps, the commands to copy, and
         a check that says which of them is not done yet.`) +
        p(`The journal itself needs none of this. Every number in it is computed locally, and
         the whole product works with the agents switched off.`)
    )}

    ${section(
      'Where your data lives',
      p(`In your Supabase project, not ours. Every table is protected by row-level security
         keyed to your user, so the database itself refuses to hand your trades to anyone else
         — the app never has to ask nicely. There is no server in between and no copy
         anywhere.`)
    )}
  </div>`
}
