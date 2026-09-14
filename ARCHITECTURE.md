# How Mazevos is built

You own this source. This is the map for reading and changing it.

It assumes you can read JavaScript, and nothing else — no framework, no build
step beyond Vite, no state library, no TypeScript in the app itself. Roughly
5,000 lines you could read in an afternoon. [SETUP.md](SETUP.md) covers
installing; this covers what you installed.

---

## The shape of it

```
src/domain/       pure rules. No DOM, no network, no clock.
src/journal/      the trade list, the log form, and the Supabase data layer
src/statistics/   the performance page
src/agents/       DOM and Finski
src/settings/     the screen that writes your configuration
src/onboarding/   first run, and the reference tab
src/lib/          auth, the client, display preferences, small shared helpers
supabase/         schema.sql, and the two Edge Functions
```

One rule explains most of the layout: **`src/domain/` is pure.** Every module in
it is a function of its arguments — no `document`, no `fetch`, no `Date.now()`
where it would change an answer. That is why the statistics have real tests and
why you can change a rule with confidence. Nothing in `domain/` imports from
`journal/`, `agents/` or `lib/`. If you find yourself wanting to, the thing you
are writing is not a rule.

Everything renders by building an HTML string and assigning `innerHTML`, then
delegating clicks from one listener on a container. That is the whole rendering
model. It is not fashionable and it is about two hundred lines of machinery you
never have to learn.

---

## Five rules that hold it together

Break these and things go wrong quietly rather than loudly, which is the worst
kind. Each one is enforced by a test.

### 1. Seventeen columns, and everything else is `custom`

`trades` has seventeen columns and will not grow. The test for a column is not
"is this field important" but **does the app compute with it generically** —
money, R's denominator, the keys the database has to order by or enforce.

Everything describing *how you trade* lives in the `custom` jsonb column, keyed
by a generated field id. Adding a field is a settings write, never a migration.
See `src/journal/mapping.js`, which is the only file where a column name appears.

If you are about to add a column, check first whether a custom field does it.
Almost always it does.

### 2. Ids are stored; labels are displayed

A trade stores `strategy: 'model_a'` and `custom: { f_7x2k: 'Opening drive' }` —
never the words the user reads. Labels live in configuration and are resolved at
render time.

This is what makes renaming free. Key anything on a display name and the first
rename orphans every row that used it, unfixably. `strategyLabel()` and
`fieldLabel()` are the resolvers, and both fall back to the raw id rather than to
a blank, so a deleted definition still shows history instead of hiding it.

### 3. The agents compute nothing

`src/domain/trade-stats.js` computes every number DOM reports. The Edge Function
sends the model finished figures and a prompt that forbids it from calculating
its own. The statistics it was given are stored beside the report in
`dom_reports.stats`, so any past report can be audited against its own inputs.

Never let a prompt ask for a number. A model that computes will produce one that
is plausible and wrong, which is worse than no answer at all.

### 4. `updated_at` is epoch milliseconds

A `bigint`, not a timestamp. The client reads it as `Number(r.updated_at)`, and a
Postgres timestamp string parses to `NaN` there, collapses to 0, and makes every
stored row look stale enough to overwrite. `mapping.js` throws if you hand it
anything else — deliberately loud, because the failure it prevents is silent data
loss.

### 5. `date` is text, and RLS is the filter

`date` is `'YYYY-MM-DDTHH:mm'` text, exactly what `<input type="datetime-local">`
emits. The list sorts on it lexicographically, which is chronological for that
shape and carries no timezone to be reinterpreted. Keep the format and everything
works; change it and sorting breaks quietly.

No query filters on `user_id`. The row-level security policies in `schema.sql`
are the filter. That is why a missed `enable row level security` would not look
like a broken query — it would look like one user reading another's book.

---

## The files

### `src/domain/` — the rules

| File | What it owns |
|---|---|
| `config.js` | The configuration shape: strategies, custom fields, statuses, currency, theme. `migrate()` reads any older shape forward, which is what keeps a settings change from ever becoming a SQL change. |
| `config-edit.js` | Every edit the Settings screen can make, as pure functions. Ids are permanent, deleting a strategy takes its scoped fields, a preset replaces rather than merges. |
| `presets.js` | The three starting configurations. A preset is only a config blob — nothing about it is privileged. |
| `trade-stats.js` | The statistics DOM reasons over. Groups by strategy, direction, status, and by every custom field it finds on the trades themselves. |
| `table-columns.js` | Which columns the trade table can show, and which are selected. |
| `header-tiles.js` | Same, for the tiles above the table. |
| `trade-vocab.js` | Directions, and the default status list. |
| `veto-vocab.js` | What kind of row an entry is. A veto has no fill, so it leaves every money figure before one is computed. |
| `account-vocab.js` | Account types. `Backtest` is the one the app treats specially. |
| `et-session.js` | Eastern-time helpers for the economic calendar. DST from the IANA database, not approximated. |

### `src/journal/` — trades

| File | What it owns |
|---|---|
| `mapping.js` | Row ↔ app object. **The only file where a column name appears.** Start here to understand the schema. |
| `trades.js` | Every trade query. Reads page through the table rather than stopping at a limit, and report `truncated` if they hit the ceiling. Archiving lives here. |
| `accounts.js` | Accounts, and the counts per account. |
| `settings.js` | Reads and writes the single configuration row. A failed read answers with a blank config rather than throwing — an unreachable settings row should cost you the tag panel, never the trade. |
| `index.js` | The journal view: tiles, filters, the table, the archive notices. Cell renderers are keyed by column id, so a custom field in the table needs no code. |
| `form.js` | The log form. Its top half is the columns; its bottom half is generated from your fields. Nothing in it names a setup or a tag. |
| `field-control.js` | One field, rendered as a control. Shared with the Settings preset preview so the preview is the real form rather than a lookalike. |
| `filters.js` | Client-side narrowing and sort. Everything it reads has to be in the list query. |
| `stats.js` | The header tiles' arithmetic, and money formatting. |
| `screenshots.js` | Downscale and re-encode before storing. Images live inside the row. |

### `src/agents/`

`contract.js` fixes the shape every agent exports — an id, a title, and a `mount`
that owns its element. Agents know nothing about navigation or each other.

`dom/` splits into `report.js` (pure: builds the payload, runs the pipeline),
`client.js` (calls the function), `reports.js` (history), `ui.js` (the screen).
`finski/` mirrors it, plus `calendar.js`, which degrades through three sources so
a missing calendar file costs the events section and not the brief.

`setup.js` probes both Edge Functions to tell Settings which setup step is
undone. It costs no tokens and never sees the key.

### `src/lib/`

`supabase.js` builds the client — and is the one place the guest preview is
swapped in. `auth.js` is sign-in and the auth-change subscription. `display.js`
owns theme and currency: both live in your settings and are mirrored into
`localStorage` so the first paint is right before the network answers.
`summary.js` is a one-slot channel so the sidebar footer can show totals a view
already computed. `ui-text.js` has the HTML escaper and the error-message
humaniser.

**`guest.js` deserves a paragraph.** It is a login bypass — an in-memory fake
Supabase behind a "Continue as guest" button, for clicking through the UI with no
database. It is gated on `import.meta.env.DEV`, which Vite replaces with the
literal `false` when building, so the whole thing folds to dead code and is
dropped. `guest.test.js` runs a real production build and greps the bundle to
prove it. **Do not make it reachable at runtime** — an env var, a query string or
a config flag all defeat the dead-code elimination and ship the bypass.

### `supabase/`

`schema.sql` is the entire database in one readable file: five tables, their
indexes, and owner-only RLS on each. Safe to re-run.

`functions/dom-report` and `functions/finski-brief` are the only server-side
code. Both resolve the caller to a real signed-in user before doing anything —
`verify_jwt` alone is not access control, because the anon key is itself a valid
project JWT and ships in the browser.

### `src/tokens.css` and `src/style.css`

`tokens.css` is the only place a colour is written down; `style.css` reads from
it and contains no raw hex. That is what makes the light theme a block of token
overrides rather than a second stylesheet. To restyle the app, start in
`tokens.css` and you may never need to open the other one.

---

## Making changes

**Change the colours.** `src/tokens.css`. The light palette is the second block.

**Add a field type.** `FIELD_TYPES` in `domain/config.js`, a case in
`journal/field-control.js`, a branch in `normaliseFieldValue`, and grouping in
`trade-stats.js:groupByCustom`. Four places, all named.

**Add a statistic.** One key in `statistics/compute.js`, one renderer in
`statistics/index.js`, one entry in its `BLOCKS` array.

**Add a column to the trade table.** An entry in `BUILTIN_COLUMNS`
(`domain/table-columns.js`) and a renderer in `CELLS` (`journal/index.js`). If it
is per-trade data rather than a computed value, consider a custom field instead —
those need no code at all.

**Change what DOM is told.** `buildReportPayload` in `agents/dom/report.js` for
the data; the prompt in `supabase/functions/dom-report/index.ts` for the words.
Redeploy the function after touching it.

**Add a nav entry.** Export an agent from `index.js`, add it to `VIEWS` and an
icon to `ICONS` in `src/main.js`.

---

## The tests

```bash
npm test
```

301 tests, 20 files, plain `node --test` — no framework, no config. They run in
about ten seconds.

They are not there for coverage. Each one pins a decision that would otherwise be
easy to undo by accident: that an empty group reports `null` rather than `0`
(because a measured zero and no measurement are different claims), that a rename
never re-keys a trade, that `updated_at` refuses anything but epoch ms, that the
guest bypass cannot reach a production build.

If you change behaviour, a test will fail and its name will tell you which
decision you just reversed. Read the name before changing the test.

---

## Things that will bite you

- **Rebuild after changing `.env`.** Those values are inlined at build time. A
  build with none produces an app that loads and throws.
- **A number field with no ranges is never grouped.** Deliberate — one bucket per
  distinct price is a table as long as your journal. Give it ranges in Settings.
- **Multi-select breakdowns over-count on purpose.** A trade with two tags is in
  two rows, so those rows sum to more than your trade count. Never total that
  column and call it trades.
- **Deleting a field keeps its answers.** They stay on the trades and in the
  statistics. Re-adding creates a *new* field with a new id; the old answers stay
  with the old one.
- **Archiving changes what is listed and nothing else.** Every tile and statistic
  still counts archived trades, by design.
- **The `custom` jsonb travels with the list query.** Keep fields to text and
  numbers. It is not a place for images.
- **Edge Function changes need a redeploy.** Nothing in the app tells you the
  deployed version is stale.
