// Shared helpers for the harvest-day collectors.
// No dependencies — plain Node, works on Windows / macOS / Linux.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function configDir() {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(base, 'harvest-day')
}

export function configPath() {
  return join(configDir(), 'config.json')
}

export function readConfig() {
  const p = configPath()
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8'))
}

export function writeConfig(cfg) {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  return configPath()
}

// Run a command, capturing stdout and stderr separately. Never throws —
// failures come back as { ok: false, error } so one broken repo or a logged-out
// CLI can't abort a whole collection run.
//
// `err` matters: several CLIs (notably `glab auth status`) exit 0 and write
// their real output to stderr, so callers that only read stdout see nothing.
export function run(cmd, args, opts = {}) {
  const base = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }
  let r = spawnSync(cmd, args, base)
  // Windows resolves some CLIs only through a shim (.cmd/.bat); retry via shell.
  if (r.error?.code === 'ENOENT' && process.platform === 'win32' && !opts.shell) {
    const quoted = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    r = spawnSync(cmd, quoted, { ...base, shell: true })
  }
  if (r.error) return { ok: false, error: String(r.error.message).trim() }
  const out = r.stdout || ''
  const err = r.stderr || ''
  if (r.status !== 0) return { ok: false, error: (err || out || `exit ${r.status}`).trim(), out, err }
  return { ok: true, out, err }
}

export function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) args[key] = true
    else {
      args[key] = next
      i++
    }
  }
  return args
}

export function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n')
}

export function fail(message) {
  emit({ ok: false, error: message })
  process.exit(1)
}

// Default key shape: HUME-1234, ENG-77. Overridable via config.ticketPattern.
export function ticketKeys(text, pattern) {
  if (!text) return []
  const re = new RegExp(pattern || '[A-Z][A-Z0-9]{1,9}-\\d+', 'g')
  return [...new Set(String(text).match(re) || [])]
}

export function isGitRepo(dir) {
  return existsSync(join(dir, '.git'))
}

// Find git repos under each root, up to `depth` levels down.
export function findRepos(roots, depth = 2) {
  const found = []
  const walk = (dir, level) => {
    if (level > depth) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
      const full = join(dir, e.name)
      if (isGitRepo(full)) found.push(full)
      else walk(full, level + 1)
    }
  }
  for (const root of roots) {
    if (isGitRepo(root)) found.push(root)
    else walk(root, 1)
  }
  return found
}

// Inclusive date range -> the exclusive bounds git and the GitLab API want.
export function dayBefore(date) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

export function dayAfter(date) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
