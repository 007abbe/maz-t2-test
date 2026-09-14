import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The guest preview is a login bypass. This is the test that keeps it out of
 * what a buyer receives.
 *
 * It does not read the source and trust a flag — it runs a real production
 * build and greps the emitted bundle for the seed data and the entry point.
 * A refactor that makes the bypass reachable at runtime (an env var, a query
 * string, a config value) defeats Vite's dead-code elimination and fails here.
 */

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const DIST = join(ROOT, 'dist')

/**
 * Strings that exist only inside guest.js.
 *
 * Account names and the seed thesis, not the preset vocabulary: guest.js seeds
 * itself from `presets.js`, which ships on purpose, so "Opening drive" reaching
 * the bundle proves nothing either way.
 */
const GUEST_MARKERS = [
  'guest_preview_active',
  'guest@preview.local',
  '__enterGuest',
  'Continue as guest',
  'Apex 50k',
  'Topstep eval',
  'Replay',
  'Opened above the overnight range',
]

function bundleText() {
  // Dummy-but-well-formed credentials. vite.config.js refuses to build without
  // them, and this test is about the guest bypass, not about the env guard —
  // supplying them here is what lets the suite run on a clean checkout that has
  // no .env at all. They take precedence over any real .env, so the bundle this
  // inspects is the same on every machine.
  execFileSync('npx', ['vite', 'build'], {
    cwd: ROOT,
    stdio: 'pipe',
    shell: true,
    env: {
      ...process.env,
      VITE_SUPABASE_URL: 'https://build-test.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'not-a-real-key-just-long-enough-to-pass',
    },
  })

  const assets = join(DIST, 'assets')
  assert.ok(existsSync(assets), 'the build should have produced dist/assets')

  return readdirSync(assets)
    .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
    .map((f) => readFileSync(join(assets, f), 'utf8'))
    .join('\n')
    .concat(readFileSync(join(DIST, 'index.html'), 'utf8'))
}

test('a production build contains no trace of the guest bypass', () => {
  const bundle = bundleText()

  for (const marker of GUEST_MARKERS) {
    assert.ok(
      !bundle.includes(marker),
      `"${marker}" reached the production bundle — the guest bypass is shipping`
    )
  }
})

test('the production build still contains the real client path', () => {
  // Guards against the opposite failure: a build that drops guest.js because it
  // dropped supabase.js with it would pass the test above for the wrong reason.
  const bundle = bundleText()

  // This used to tolerate two shapes, because a build with no .env inlined the
  // credentials as undefined and tree-shook createClient away entirely. That
  // build can no longer happen — vite.config.js refuses it — and bundleText()
  // always supplies credentials, so exactly one shape is correct now: the real
  // client is present.
  assert.ok(
    bundle.includes('gotrue'),
    'the real Supabase client did not survive the build'
  )
})
