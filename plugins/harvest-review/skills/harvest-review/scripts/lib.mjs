// Shared helpers for the harvest-review scripts.
// No dependencies — plain Node, works on Windows / macOS / Linux.
//
// This file deliberately overlaps with harvest-log's lib.mjs. The two plugins
// install and version independently, so they cannot import from each other;
// where the logic is identical (command spawning on Windows, arg parsing) the
// code is the same and should be fixed in both places if it turns out wrong.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'

export function configDir() {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(base, 'harvest-review')
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

// Fetched data lands on disk rather than in the agent's context. A month of a
// ten-person team is a few thousand entries; read into a conversation that is
// most of a context window spent before a single check has run, and it is spent
// on data no human will read. The scanners read the cache, the agent reads the
// findings.
export function cacheDir() {
  return join(configDir(), 'cache')
}

export function cachePath(name) {
  return join(cacheDir(), name)
}

export function writeCache(name, data) {
  mkdirSync(cacheDir(), { recursive: true })
  const p = cachePath(name)
  writeFileSync(p, JSON.stringify(data), 'utf8')
  return p
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// --- Process spawning (see harvest-log/scripts/lib.mjs for the full rationale)

const resolveCache = new Map()

function resolveWindowsCommand(cmd) {
  if (resolveCache.has(cmd)) return resolveCache.get(cmd)
  let found = null
  if (/[\\/]/.test(cmd)) {
    found = existsSync(cmd) ? cmd : null
  } else {
    const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    const dirs = (process.env.PATH || '').split(';').filter(Boolean)
    search: for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = join(dir, cmd + ext)
        if (existsSync(candidate)) {
          found = candidate
          break search
        }
      }
    }
  }
  resolveCache.set(cmd, found)
  return found
}

function spawnResult(r) {
  if (r.error) return { ok: false, error: String(r.error.message).trim() }
  const out = r.stdout || ''
  const err = r.stderr || ''
  if (r.status !== 0) return { ok: false, error: (err || out || `exit ${r.status}`).trim(), out, err }
  return { ok: true, out, err }
}

// Never throws — a broken CLI comes back as { ok: false, error } so one failing
// source can't abort a review that the other sources could still answer.
export function run(cmd, args, opts = {}) {
  const base = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }

  if (process.platform !== 'win32') return spawnResult(spawnSync(cmd, args, base))

  const resolved = resolveWindowsCommand(cmd)
  if (!resolved) return { ok: false, error: `${cmd} not found on PATH` }

  const ext = extname(resolved).toLowerCase()
  if (ext !== '.cmd' && ext !== '.bat') return spawnResult(spawnSync(resolved, args, base))

  if (/\s/.test(resolved)) {
    return {
      ok: false,
      error: `${cmd} resolves to a batch shim inside a path containing spaces (${resolved}), which cannot be launched safely. Install the native executable, or move the shim somewhere without spaces.`,
    }
  }
  return spawnResult(spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', resolved, ...args], base))
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
  const pretty = process.env.HARVEST_REVIEW_PRETTY === '1'
  process.stdout.write(JSON.stringify(obj, null, pretty ? 2 : 0) + '\n')
}

export function prune(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue
    if (Array.isArray(v) && v.length === 0) continue
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue
    out[k] = v
  }
  return out
}

export function fail(message, extra = {}) {
  emit({ ok: false, error: message, ...extra })
  process.exit(1)
}

// Emit a final payload and set the exit status *without* calling process.exit.
//
// Use this in any script that has made an HTTP request. On Windows, calling
// process.exit() while fetch's connection handles are still closing trips a
// libuv assertion — the output is already written, but the process dies with a
// panic and a garbage exit code, so a caller cannot tell success from failure.
// Deferring the exit by a tick only makes it intermittent, which is worse.
// Letting the loop drain instead costs about a third of a second and exits
// cleanly, because the sockets are unref'd.
//
// It does not stop execution: return after calling it.
export function finish(obj, code = 0) {
  emit(obj)
  process.exitCode = code
}

export const DEFAULT_TICKET_PATTERN = '[A-Z][A-Z0-9]{1,9}-\\d+'

export function ticketKeys(text, pattern) {
  if (!text) return []
  const re = new RegExp(pattern || DEFAULT_TICKET_PATTERN, 'g')
  return [...new Set(String(text).toUpperCase().match(re) || [])]
}

// --- Dates ---------------------------------------------------------------
//
// Everything here works on Harvest's `spent_at`, which is already a plain local
// calendar date ("2026-07-31") with no time and no zone. Resist the urge to
// parse it into a Date and back: that round-trips through UTC and moves a
// timesheet day for anyone west of Greenwich.

export function dayAfter(date, n = 1) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function dayBefore(date, n = 1) {
  return dayAfter(date, -n)
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
}

// 0 = Sunday. Computed in UTC from a zoneless date string, which is exactly
// what a calendar date means.
export function weekday(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}

export function isWeekend(date) {
  const d = weekday(date)
  return d === 0 || d === 6
}

// ISO-ish week bucket, only ever compared against itself.
export function weekKey(date) {
  const d = new Date(`${date}T00:00:00Z`)
  const day = (d.getUTCDay() + 6) % 7 // Monday = 0
  d.setUTCDate(d.getUTCDate() - day)
  return d.toISOString().slice(0, 10)
}

export function eachDate(from, to) {
  const out = []
  for (let d = from; d <= to; d = dayAfter(d)) out.push(d)
  return out
}

export function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
}

// --- Text ----------------------------------------------------------------

// The comparison key for "is this the same note again". Lowercase, punctuation
// and whitespace flattened, ticket keys kept — a note that differs only by its
// key is a different note, and one that differs only by a trailing full stop is
// not.
export function normalizeNote(note) {
  return String(note || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function round(n, to = 0.01) {
  return Math.round(n / to) * to
}

export function sum(xs) {
  return xs.reduce((a, b) => a + b, 0)
}

export function median(xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

export function groupBy(items, keyFn) {
  const map = new Map()
  for (const item of items) {
    const k = keyFn(item)
    if (!map.has(k)) map.set(k, [])
    map.get(k).push(item)
  }
  return map
}

// --- Harvest REST --------------------------------------------------------
//
// The MCP is fine for one person's week and wrong for a team's month: every
// entry it returns is an entry the agent has to hold. These helpers talk to the
// API directly so the volume lands in a cache file instead.

export function harvestCredentials(cfg) {
  const tokenEnv = cfg?.harvest?.tokenEnv || 'HARVEST_TOKEN'
  const accountEnv = cfg?.harvest?.accountIdEnv || 'HARVEST_ACCOUNT_ID'
  const token = process.env[tokenEnv] || process.env.HARVEST_REVIEW_TOKEN || null
  const accountId = process.env[accountEnv] || process.env.HARVEST_REVIEW_ACCOUNT_ID || null
  return { token, accountId, tokenEnv, accountEnv }
}

const HARVEST_BASE = process.env.HARVEST_REVIEW_API_BASE || 'https://api.harvestapp.com/api/v2'

// One page. Throws only on a programming error; HTTP failures come back as
// { ok: false } carrying the status, because a 401 and a 429 want different
// advice and both want to reach the user rather than a stack trace.
async function harvestGet(path, { token, accountId }) {
  const url = path.startsWith('http') ? path : `${HARVEST_BASE}${path}`
  let res
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Harvest-Account-Id': String(accountId),
        'User-Agent': 'harvest-review (claude-code plugin)',
      },
    })
  } catch (e) {
    return { ok: false, error: `network error: ${e.message}` }
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, error: 'Harvest rejected the token (401/403) — check the PAT and the account id' }
  }
  if (res.status === 429) {
    return { ok: false, status: 429, error: 'rate limited', retryAfter: Number(res.headers.get('retry-after') || 15) }
  }
  if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
  return { ok: true, data: await res.json() }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Walk every page of a Harvest collection. Harvest allows 100 requests per 15
// seconds; a 429 is expected on a large fetch rather than exceptional, so back
// off and continue instead of failing the run.
export async function harvestPaged(path, creds, key, { maxPages = 200 } = {}) {
  const items = []
  // Follow `links.next` when Harvest offers it (absolute, cursor-bearing) and
  // fall back to page numbers built from the *original* path — appending a page
  // parameter to the previous URL would stack `page=2&page=3` and quietly loop.
  let next = path
  let pages = 0
  while (next && pages < maxPages) {
    const r = await harvestGet(next, creds)
    if (!r.ok && r.status === 429) {
      await sleep((r.retryAfter || 15) * 1000)
      continue
    }
    if (!r.ok) return { ok: false, error: r.error, items, pages }
    pages++
    items.push(...(r.data[key] || []))
    if (r.data.links?.next) next = r.data.links.next
    else if (r.data.next_page) next = `${path}${path.includes('?') ? '&' : '?'}page=${r.data.next_page}`
    else next = null
  }
  return { ok: true, items, pages, truncated: pages >= maxPages ? true : null }
}
