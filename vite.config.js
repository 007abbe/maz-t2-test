import { defineConfig, loadEnv } from 'vite'

/**
 * `base` decides what the built asset URLs are relative to, and there is no one
 * right answer for a product the buyer hosts themselves.
 *
 * The default is './' — relative paths, which work when the app is served from
 * a domain root, from a subfolder, or straight off disk. That covers every
 * deploy route SETUP.md documents, GitHub Pages under a repo path included,
 * which is why SETUP.md now tells nobody to set this. BASE_PATH remains as an
 * escape hatch for a buyer who genuinely needs an absolute base -- note it is
 * POSIX-shell syntax only: an inline VAR=x prefix is a parse error in
 * PowerShell and cmd.exe, and Git Bash on Windows rewrites a leading /repo/
 * into an absolute path inside the Git install.
 *
 * Hardcoding a repo path here is what breaks a self-hosted install: every asset
 * 404s and the page renders blank with no error the buyer can act on.
 */

const REQUIRED = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']

/** The literal values in .env.example — copied but never filled in. */
const PLACEHOLDERS = new Set(['https://your-project.supabase.co', 'your-anon-key'])

/**
 * Refuse to build without Supabase credentials.
 *
 * This exists because the failure it prevents is silent. Vite inlines
 * `import.meta.env.*` at build time, so with no values the guard in
 * src/lib/supabase.js becomes unconditional, `createClient` is tree-shaken out
 * entirely, and the build *succeeds* — emitting a ~74 kB bundle that loads to a
 * blank page. A buyer who builds before writing .env gets no error, no warning
 * and no way to tell a broken app from a working one.
 *
 * Checked on `build` only. `vite dev` is left alone: the runtime guard already
 * throws visibly in the browser, and the guest preview is meant to run before a
 * buyer has any credentials at all.
 *
 * Values are read from the process environment *and* from .env files, because
 * CI supplies them the first way (see .github/workflows/deploy.yml) and a local
 * build the second.
 */
export function assertConfigured(mode, dir = process.cwd()) {
  const fromFiles = loadEnv(mode, dir, '')
  const read = (key) => String(process.env[key] ?? fromFiles[key] ?? '').trim()

  const missing = REQUIRED.filter((key) => !read(key))
  const unfilled = REQUIRED.filter((key) => PLACEHOLDERS.has(read(key)))

  if (missing.length || unfilled.length) {
    const lines = ['', 'Refusing to build: Supabase credentials are not set.', '']

    if (missing.length) lines.push(`  Missing:     ${missing.join(', ')}`)
    if (unfilled.length) {
      lines.push(`  Still the .env.example placeholder: ${unfilled.join(', ')}`)
    }

    lines.push(
      '',
      'Without them this build would still SUCCEED and produce a ~74 kB app that',
      'loads to a blank page with no error — which is why this check exists.',
      '',
      'Locally:',
      '  cp .env.example .env      # then fill in both values',
      '',
      'In GitHub Actions:',
      '  add both as repository secrets under',
      '  Settings -> Secrets and variables -> Actions',
      '',
      'Both values live in your Supabase dashboard under Project Settings -> API.',
      'The anon key is designed to be public — it is not a secret, and row-level',
      'security is what protects your trades.',
      ''
    )

    throw new Error(lines.join('\n'))
  }

  // Shape checks warn rather than fail: a self-hosted Supabase has its own URL,
  // and the key format has changed before. Wrong-looking is not wrong.
  const url = read('VITE_SUPABASE_URL')
  if (!/^https?:\/\//.test(url)) {
    console.warn(`\n[env] VITE_SUPABASE_URL does not look like a URL: ${url}\n`)
  }
  if (read('VITE_SUPABASE_ANON_KEY').length < 20) {
    console.warn('\n[env] VITE_SUPABASE_ANON_KEY looks too short to be a real key.\n')
  }
}

export default defineConfig(({ command, mode }) => {
  if (command === 'build') assertConfigured(mode)

  return {
    base: process.env.BASE_PATH ?? './',
  }
})
