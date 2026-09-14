import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { assertConfigured } from '../../vite.config.js'

/**
 * The build-time credential guard.
 *
 * The failure it exists to prevent is the quietest one in the product: with no
 * VITE_SUPABASE_* values, Vite inlines them as undefined, tree-shakes the whole
 * Supabase client out, and reports a successful build of a ~74 kB app that
 * loads to a blank page. A buyer following SETUP.md out of order gets no error.
 *
 * Tested against a throwaway directory rather than through a real `vite build`,
 * so it neither depends on nor disturbs whatever .env this machine has.
 */

/** A directory with the given .env contents, or none at all. */
function sandbox(envContents) {
  const dir = mkdtempSync(join(tmpdir(), 'mazevos-env-'))
  if (envContents !== null) writeFileSync(join(dir, '.env'), envContents)
  return dir
}

/** assertConfigured reads process.env first, so tests must run without these. */
function withoutProcessEnv(fn) {
  const saved = {
    VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY,
  }
  delete process.env.VITE_SUPABASE_URL
  delete process.env.VITE_SUPABASE_ANON_KEY

  try {
    fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const GOOD = [
  'VITE_SUPABASE_URL=https://example.supabase.co',
  'VITE_SUPABASE_ANON_KEY=long-enough-to-look-like-a-real-key',
].join('\n')

test('a build with no credentials at all is refused', () => {
  withoutProcessEnv(() => {
    const dir = sandbox(null)
    try {
      assert.throws(() => assertConfigured('production', dir), {
        message: /Refusing to build/,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('the refusal names both missing variables, so the fix is obvious', () => {
  withoutProcessEnv(() => {
    const dir = sandbox(null)
    try {
      assert.throws(() => assertConfigured('production', dir), (err) => {
        assert.match(err.message, /VITE_SUPABASE_URL/)
        assert.match(err.message, /VITE_SUPABASE_ANON_KEY/)
        return true
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('copying .env.example without filling it in is refused too', () => {
  // The realistic near-miss: the file exists, so every "is there a .env" check
  // passes, and the values are the placeholders from .env.example.
  withoutProcessEnv(() => {
    const dir = sandbox(
      [
        'VITE_SUPABASE_URL=https://your-project.supabase.co',
        'VITE_SUPABASE_ANON_KEY=your-anon-key',
      ].join('\n')
    )
    try {
      assert.throws(() => assertConfigured('production', dir), {
        message: /placeholder/,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('an empty value is treated as missing, not as set', () => {
  withoutProcessEnv(() => {
    const dir = sandbox('VITE_SUPABASE_URL=\nVITE_SUPABASE_ANON_KEY=   ')
    try {
      assert.throws(() => assertConfigured('production', dir), {
        message: /Refusing to build/,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('credentials in a .env file pass', () => {
  withoutProcessEnv(() => {
    const dir = sandbox(GOOD)
    try {
      assert.doesNotThrow(() => assertConfigured('production', dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('credentials from the process environment pass with no .env present', () => {
  // This is the CI path: .github/workflows/deploy.yml passes both as env vars
  // from repository secrets, and never writes a .env file.
  withoutProcessEnv(() => {
    const dir = sandbox(null)
    process.env.VITE_SUPABASE_URL = 'https://ci.supabase.co'
    process.env.VITE_SUPABASE_ANON_KEY = 'long-enough-to-look-like-a-real-key'
    try {
      assert.doesNotThrow(() => assertConfigured('production', dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
