-- Mazevos — the whole database, in one file.
--
-- Run this once against an empty Supabase project (SQL Editor → paste → Run).
-- It is idempotent: every statement is `if not exists` or drops and recreates,
-- so re-running it after an upgrade is safe and changes nothing already there.
--
-- Design rule (ARCHITECTURE.md, rule 1): the `trades` table holds only what the
-- application itself computes with. Everything that describes *how you trade* —
-- setups, tags, targets, prices, conviction, whatever vocabulary you invent —
-- lives in the `custom` jsonb column and is defined from the Settings screen.
-- Adding a field is a write, never a migration. You should never have to edit
-- this file to record something new about a trade.

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------
-- Optional. A journal with no accounts works; every trade is simply unassigned.
create table if not exists public.accounts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  -- 'Live' | 'Funded' | 'Evaluation' | 'Demo' | 'Backtest'. Text, not an enum:
  -- adding a type should not be a migration. 'Backtest' is the one value the
  -- app treats specially — those trades are held out of every live statistic.
  type       text not null default 'Evaluation',
  note       text,
  created_at timestamptz not null default now()
);

create index if not exists accounts_user_created_idx
  on public.accounts (user_id, created_at);

-- ---------------------------------------------------------------------------
-- trades
-- ---------------------------------------------------------------------------
create table if not exists public.trades (
  -- Client-generated text, not a uuid or a serial: it is minted before the row
  -- exists, so the trade already knows its own upsert key at first save.
  id         text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,

  -- Last-write-wins merge key, in epoch MILLISECONDS. Not a timestamptz: the
  -- client reads it as `Number(r.updated_at)`, and a timestamp string would
  -- parse to NaN, collapse to 0, and make every stored row look stale enough
  -- to overwrite. See mapping.js:assertEpochMs.
  updated_at bigint not null,

  -- Display counter, not a key. `nextTradeNum` reads max(num) + 1, so it has to
  -- be orderable in SQL — which a jsonb key is not, numerically.
  num        integer,

  -- 'YYYY-MM-DDTHH:mm' text, exactly what <input type="datetime-local"> emits.
  -- Text rather than timestamptz on purpose: the journal sorts on it
  -- lexicographically, which is chronological for this shape, and it carries no
  -- timezone to be re-interpreted between the browser and the server.
  date       text,

  direction  text,          -- 'Long' | 'Short'
  status     text,          -- 'Open' | 'TP' | 'SL' | 'BE' | … ; null on a veto

  -- The money. Both default 0 and are never null, because every aggregate in
  -- the product sums them and a null would have to be coalesced at each site.
  pnl        numeric not null default 0,
  -- R's denominator: R = pnl / risk, everywhere. This is why risk is a column
  -- and not a custom field — if it could be renamed or deleted, every average R
  -- in the app would silently go null while still reporting confidently.
  risk       numeric not null default 0,

  -- 'trade' | 'veto' | null. Null means trade. This changes what the row *is*:
  -- a veto has no fill, so it is excluded from P&L, win rate and trade count
  -- before any of them are computed.
  kind       text,

  -- Null means unassigned, which is a real answer. `on delete set null` is the
  -- reason this is a column: deleting an account must unassign its trades, not
  -- orphan them — and a foreign key cannot live inside jsonb.
  account_id uuid references public.accounts(id) on delete set null,

  -- A strategy *id* from config ('model_a'…), never its label, so renaming a
  -- strategy leaves every historical trade grouped where it was. Null =
  -- untagged, which every trade logged before you defined a strategy is.
  strategy   text,

  -- The trader's own words. Heavy, and deliberately not in the list query.
  thesis     text,
  hindsight  text,
  image      text,          -- base64 data URL, compressed client-side

  -- Everything else. Keyed by the generated field id from
  -- `settings.config.custom_fields` — never by the field's label, so renaming a
  -- field renames a heading and moves no trade between buckets (§4.2).
  custom     jsonb not null default '{}'::jsonb,

  -- Out of the working list, not out of the journal. Archiving keeps the trade
  -- table short on a long-running journal; every statistic still counts these,
  -- because a number that quietly changed meaning after an archive would be
  -- worse than a long table. A column rather than a custom field because the
  -- list query filters on it in SQL.
  archived   boolean not null default false
);

-- `create table if not exists` above does nothing to a table that already
-- exists, so a column added in a later version needs saying twice. This is what
-- makes the "safe to re-run after an upgrade" claim at the top true rather than
-- aspirational: an install from before archiving picks the column up here.
alter table public.trades add column if not exists archived boolean not null default false;

-- The list view's only ordering, narrowed by the archive flag it filters on.
create index if not exists trades_user_archived_date_idx
  on public.trades (user_id, archived, date desc);

-- nextTradeNum: max(num) for this user.
create index if not exists trades_user_num_idx
  on public.trades (user_id, num desc);

create index if not exists trades_account_idx
  on public.trades (account_id);

-- Lets a stats query filter on a custom field without a table scan.
create index if not exists trades_custom_idx
  on public.trades using gin (custom);

-- ---------------------------------------------------------------------------
-- settings
-- ---------------------------------------------------------------------------
-- Exactly one row per user, holding one jsonb blob. `id` is fixed at 1 so the
-- client's `upsert(..., { onConflict: 'id' })` cannot race a second row into
-- existence. The check constraint is what makes that guarantee real.
create table if not exists public.settings (
  id      integer primary key default 1 check (id = 1),
  user_id uuid not null references auth.users(id) on delete cascade,
  config  jsonb not null default '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- Agent history
-- ---------------------------------------------------------------------------
create table if not exists public.dom_reports (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  scope      text,
  trade_ids  text[] not null default '{}',
  -- The Layer 1 numbers the report was written from, stored beside the prose so
  -- a past report can be audited against the figures it actually saw.
  stats      jsonb,
  report     text
);

create index if not exists dom_reports_user_created_idx
  on public.dom_reports (user_id, created_at desc);

create table if not exists public.finski_briefs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  data       jsonb,
  brief      text
);

create index if not exists finski_briefs_user_created_idx
  on public.finski_briefs (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- Every table is owner-only. The client never filters on user_id — these
-- policies are the filter, which is why a missing `enable row level security`
-- would not show up as a broken query but as one user reading another's book.
alter table public.accounts      enable row level security;
alter table public.trades        enable row level security;
alter table public.settings      enable row level security;
alter table public.dom_reports   enable row level security;
alter table public.finski_briefs enable row level security;

drop policy if exists accounts_owner      on public.accounts;
drop policy if exists trades_owner        on public.trades;
drop policy if exists settings_owner      on public.settings;
drop policy if exists dom_reports_owner   on public.dom_reports;
drop policy if exists finski_briefs_owner on public.finski_briefs;

create policy accounts_owner on public.accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy trades_owner on public.trades
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy settings_owner on public.settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy dom_reports_owner on public.dom_reports
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy finski_briefs_owner on public.finski_briefs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
