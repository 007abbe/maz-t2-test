# Setting up Mazevos

Mazevos is self-hosted. There is no account with us, no server in the middle and
no copy of your trades anywhere but the database you create in the next ten
minutes. That is the whole point of it, and it is also why setup is not one
click.

Read this once through before starting. **Step 4 has an ordering trap that
produces an app which looks built and does not work** — it is the only step where
doing things in the wrong order fails quietly.

---

## What you need

| | |
|---|---|
| **Node 22.12 or newer** | `node --version`. Take the **LTS** button at [nodejs.org](https://nodejs.org). |
| **A Supabase account** | Free tier is enough to start. [supabase.com](https://supabase.com) |
| **An Anthropic API key** | Optional — only for the two agents, DOM and Finski. The journal, the statistics and everything else work without one. |
| **Windows, macOS or Linux** | All three are fine. Commands below are written for a POSIX shell (macOS, Linux, Git Bash, WSL); the two places Windows differs are flagged under the command. |

About twenty minutes, most of it waiting for a Supabase project to finish
provisioning.

---

## 1. Create a Supabase project

In the Supabase dashboard: **New project**. Pick any name, pick a region near
you, and **save the database password somewhere** — you will not need it for
this install, but you will need it the day you want a backup.

Wait for it to finish provisioning before continuing.

## 2. Create the database

In your project: **SQL Editor → New query**. Open `supabase/schema.sql` from
this folder, paste the whole file in, and **Run**.

That creates five tables, their indexes, and row-level security on every one of
them. The security policies are not decoration: they are what makes the database
itself refuse to hand your trades to anyone but you, so the app never has to ask
nicely. Do not skip this file or write the tables by hand.

The file is safe to re-run. Every statement checks whether the thing already
exists, which is also how upgrades work — see [Upgrading](#upgrading) at the
bottom.

## 3. Create your login

**This is the step people miss.** Mazevos has a sign-in screen and no sign-up
screen, on purpose: it is a single-user product, and an open registration form on
a self-hosted app is a way for strangers to fill your database.

So create your user by hand:

**Authentication → Users → Add user → Create new user.** Give it your email and
a password, and tick **Auto Confirm User** so you do not have to wire up email
delivery to log in once.

That email and password are what you will sign in with.

## 4. Point the app at your project

You need two values from **Project Settings → API**:

- the **Project URL** (`https://something.supabase.co`)
- the **anon / public** key — the long one labelled public, *not* the service
  role key

Copy `.env.example` to `.env` and fill them in:

```bash
cp .env.example .env
```

**On Windows.** That line works as written in PowerShell, where `cp` is an
alias for `Copy-Item`. In cmd.exe it is `copy .env.example .env`.

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

> **The trap.** These values are baked into the app when it is *built*, not read
> when it runs. If you build before writing `.env`, you get a bundle with no
> database in it — the page loads and throws, and rebuilding is the only fix.
> Write `.env` first, and rebuild after ever changing it.

The anon key is designed to be public and ships inside the built app. It is not a
password: it grants nothing on its own, because every table's security policy
requires a signed-in user. The **service role** key is the dangerous one. Never
put that in `.env`, and never let it near the browser.

## 5. Run it

```bash
npm install
npm run dev
```

Open the URL it prints — usually `http://localhost:5173`. Sign in with the user
you created in step 3.

You should land in a short walkthrough. Pick a preset or start blank; you can
change any of it later, and Settings can replay the walkthrough whenever you
like.

To check the real production build before hosting it anywhere:

```bash
npm run build
npm run preview
```

## 6. Host it

`npm run build` writes a folder called `dist/` containing plain static files.
There is no server component. Three ways to use it, in ascending order of
effort:

**Run it locally.** `npm run dev` whenever you want to journal. Nothing is
published, your trades still sync to your Supabase project, and you can open the
same journal from another machine by installing there too. Simplest and most
private.

**Any static host.** Netlify, Vercel, Cloudflare Pages, an S3 bucket, a folder on
your own server — upload `dist/` and you are done. Asset paths are relative, so
it works from a domain root or a subfolder without configuration.

**GitHub Pages.** A workflow is included at `.github/workflows/deploy.yml`. Add
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as repository secrets
(**Settings → Secrets and variables → Actions**) and enable Pages. It
serves from a repo subpath unless you point a custom domain at it; asset paths
are relative either way, so there is nothing further to configure.

Whatever you choose: **make the site private if your host supports it.** The app
itself is safe to publish — every request needs a signed-in user — but there is
no reason to advertise where your journal lives.

## 7. Optional: the agents

DOM (post-trade analysis) and Finski (pre-market brief) call Anthropic. They run
as Edge Functions inside *your* Supabase project, on *your* API key, and you pay
Anthropic directly for what they use. Nothing routes through anyone else.

Skip this entirely if you do not want them. Everything else works without it.

**Link the project once:**

```bash
npx supabase login
npx supabase link --project-ref your-project-ref
```

The project ref is the subdomain of your project URL — the `abcdefgh` in
`https://abcdefgh.supabase.co`.

**Deploy the two functions:**

```bash
npx supabase functions deploy dom-report
npx supabase functions deploy finski-brief
```

Deploy them normally. Do **not** pass `--no-verify-jwt`: these functions spend
money, and JWT verification plus the user check inside them is what keeps a
stranger from spending it.

**Create an API key** at
[console.anthropic.com](https://console.anthropic.com/settings/keys) → API keys →
Create key. It begins `sk-ant-`.

**Set it as a project secret:**

```bash
npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
```

or in the dashboard under **Project Settings → Edge Functions → Secrets**, named
exactly `ANTHROPIC_API_KEY`.

The key lives only there. It is read server-side and never reaches the app or
your browser — which is why there is no field for it in Settings. What Settings
*does* have, under **Agents & API key**, is a check that tells you which of these
steps is not done yet. Use it to confirm the setup rather than guessing.

## 8. Optional: the economic calendar

Finski's **Events** section reads a calendar file. It looks in three places, in
order: a copy served alongside the app, then the feed directly, then a stale
cached copy. The direct feed is usually blocked by the browser, so without the
first one Finski will brief you with an empty events list.

The simplest fix, if you host the app yourself:

```bash
mkdir -p public/data
curl -sf https://nfs.faireconomy.media/ff_calendar_thisweek.json \
  -o public/data/ff_calendar.json
```

then rebuild. Anything in `public/` is copied into `dist/` as-is.

**On Windows.** In PowerShell `curl` is an alias for `Invoke-WebRequest`,
which rejects curl's flags — *"A parameter cannot be found that matches
parameter name 'sf'"*. Call the real one by name; `curl.exe` ships with
Windows 10 and 11:

```powershell
mkdir -p public/data
curl.exe -sf https://nfs.faireconomy.media/ff_calendar_thisweek.json -o public/data/ff_calendar.json
```

`mkdir -p` needs no change — PowerShell reads `-p` as `-Path` and creates
the parent for you — but unlike the POSIX version it fails if `public/data`
already exists, so skip that line on the weekly refresh.

That file is a week of events, so it needs refreshing weekly. If you host from a
GitHub repository, `.github/workflows/calendar.yml` does exactly the above on a
schedule and commits the result. Otherwise, re-run the command when the briefs
start looking thin, or leave it — everything else in the brief still works.

---

## Troubleshooting

**A blank page, and the console says `Missing VITE_SUPABASE_URL`.**
`.env` was missing or empty when you built. Fill it in and rebuild — see the trap
in step 4.

**"Invalid login credentials".**
The user does not exist yet, or was created without **Auto Confirm User** and is
waiting on a confirmation email that has nowhere to go. Check
**Authentication → Users**; delete and recreate with auto-confirm ticked.

**Signed in, but the journal says it could not load trades.**
`schema.sql` has not been run, or was run against a different project than the
one in `.env`. Check **Table Editor** for a `trades` table.

**The app loads but every page is empty and nothing saves.**
Almost always row-level security: the tables exist but the policies did not. Re-run
`schema.sql` — it is safe, and the policy block at the bottom is written to be
re-runnable.

**DOM or Finski says the key is not set.**
Open **Settings → Agents & API key** and press *Check again*. It distinguishes
"functions not deployed" from "no key set", which are different problems with
different fixes. Note that `supabase secrets set` takes effect on the next
function invocation, not instantly.

---

## Where your data lives

| What | Where |
|---|---|
| Trades, accounts, settings, agent history | Your Supabase project, in Postgres |
| Chart screenshots | Inside the trade row itself, as compressed JPEG |
| Your Anthropic key | A secret in your Supabase project. Never in the app, never in the browser |
| Theme and currency | Your settings row, mirrored into your browser's local storage so the first paint is right |

Nothing is sent anywhere else. The two typefaces ship inside the app, so
loading a page contacts no font CDN and no analytics of any kind; there is no
telemetry and no error reporting in the product. The agents are the only
outbound calls, they go from your Supabase project to Anthropic, and they only
run when you press the button.

One honest footnote: if you skip step 8, Finski falls back to fetching the
economic calendar straight from `nfs.faireconomy.media` in your browser. Most
browsers block it, it happens only when you run a brief, and the request
carries nothing about you or your trades — but it is a request to someone
else's server, so it is named here rather than glossed over.

Screenshots are worth one note: they are stored in the trade itself, so a
thousand trades with a screenshot each is roughly 400 MB of database. **Settings
→ Data** keeps a running count. Watch it before you outgrow a free tier by
surprise.

## Backups

Supabase takes its own, on a schedule that depends on your plan. For a copy you
control, the dashboard's **Database → Backups** page can produce a dump, and the
CLI can too:

```bash
npx supabase db dump -f mazevos-backup.sql
```

It is a journal. Back it up like one.

## Upgrading

Replace the app files, then:

```bash
npm install
npm run build
```

and re-run `supabase/schema.sql` in the SQL Editor. It is written to be safe to
re-run: existing tables are left alone, and columns added in a newer version are
picked up by the `alter table … add column if not exists` lines. Your data is not
touched.

If a release adds or changes an Edge Function, deploy it again — step 7.
