# Mazevos

A trading journal that does not know how you trade.

Every journal that ships with someone else's setups quietly teaches you to trade
like them. This one records the arithmetic — money, risk, R — and lets you write
the rest of the vocabulary yourself. Setups, tags, target levels, entry prices,
conviction, mood: whatever you want to measure is a field you define, and each
one becomes its own breakdown in the statistics automatically.

**Start here: [SETUP.md](SETUP.md).** About twenty minutes.

---

## What it is

- **A journal.** Direction, date, status, P&L, risk, account, thesis, hindsight,
  screenshot — plus whatever else you decide a trade should record. Log ideas you
  *passed on* as vetoes; they stay out of every money figure and are counted on
  their own.
- **Statistics.** Cumulative P&L, the usual ratios, and one breakdown per field
  you defined. Nothing here is hardcoded to a style of trading.
- **Two optional agents.** DOM reviews trades you select; Finski writes a
  pre-market brief. Every number they report is computed locally first — they
  interpret figures, they never calculate them, and the statistics behind a
  report are stored alongside it so it can be audited.

## Self-hosted, and that is the point

There is no account with us, no server in the middle, and no copy of your trades
anywhere but the Supabase project you create. Row-level security means the
database itself refuses to hand your data to anyone else. The agents are the only
outbound calls — from your project to Anthropic, on your own API key, only when
you press the button.

## Requirements

Node 22.12+, a Supabase account (free tier is fine), and — only if you want the
agents — an Anthropic API key.

## Commands

```bash
npm install
npm run dev       # local dev server
npm run build     # static site into dist/
npm run preview   # serve the built site
npm test          # the test suite
```

## Layout

```
src/domain/      pure rules — config, statistics, vocabulary. No DOM, no network.
src/journal/     the trade list, the log form, the data layer
src/statistics/  the performance page
src/agents/      DOM and Finski
src/settings/    the screen that makes the journal yours
src/onboarding/  first run, and the reference tab
supabase/        schema.sql, and the two Edge Functions
```

`supabase/schema.sql` is the entire database, in one file you can read.

## Licence

One licence, one trader, your own machines. Modify it freely for your own use;
do not redistribute, resell or publish it. No warranty, and nothing it produces
is financial advice. See [LICENSE](LICENSE), which is the same End User Licence
Agreement you accepted at checkout.

The other three documents you accepted are in `legal/`: the Terms of Service
(the sale, support, liability and governing law), the Return Policy, and the
Privacy Policy.
