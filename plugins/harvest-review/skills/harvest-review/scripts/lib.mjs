// Shared helpers for the harvest-review scripts.
// No dependencies — plain Node, works on Windows / macOS / Linux.
//
// This file deliberately overlaps with harvest-log's lib.mjs. The two plugins
// install and version independently, so they cannot import from each other;
// where the logic is identical (command spawning on Windows, arg parsing) the
// code is the same and should be fixed in both places if it turns out wrong.

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join } from 'node:path'

export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

export function configDir() {
  return join(claudeDir(), 'harvest-review')
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

// --- Secrets -------------------------------------------------------------
//
// Every plugin in this marketplace reads its API keys the same way: from the
// process environment first, then from a single shared file at
// `~/.claude/.env-keys` (`$CLAUDE_CONFIG_DIR/.env-keys`). The environment wins
// so that CI and one-off overrides keep working without touching the file.
//
// Why a file at all, when environment variables already worked:
//
//   - On Windows a persisted user variable is invisible until a new terminal
//     starts, so setup appears to fail and the user sets it twice.
//   - Telling someone to run `export TOKEN=pat...` puts the secret in their
//     shell history, and puts it in the agent transcript if the agent runs it.
//     `keys.mjs --set` reads the value from stdin instead.
//   - Nothing could enumerate what a machine had configured. One file can be
//     listed, backed up, and revoked.
//
// What has *not* changed: config.json still stores the variable *name*
// (`harvest.tokenEnv`, `bamboo.apiKeyEnv`), never the value. A secret in a
// config file is a secret in a file people paste into issues.
//
// The format is a deliberately small subset of dotenv — `KEY=value`, `#`
// comments, optional surrounding quotes. No interpolation, no multi-line
// values, no `${...}` expansion: a key store that can execute or reference
// things is a key store with surprises in it.

export function keysPath() {
  return join(claudeDir(), '.env-keys')
}

// Read the key file whatever Windows wrote it as.
//
// This matters more than it sounds. `$v > .env-keys` and `Out-File` in Windows
// PowerShell produce **UTF-16LE with a BOM**, so a file that looks perfect in
// an editor arrives here as `H\0A\0R\0V\0...` and every key name misses. The
// failure mode is the worst kind: the file exists, the key is in it, `--list`
// says it is not set, and nothing looks wrong.
//
// So: sniff the BOM and decode accordingly rather than assuming UTF-8. Files
// this code writes are always UTF-8, and rewriting a UTF-16 one converts it.
function readTextFile(path) {
  const buf = readFileSync(path)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2)
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return buf.swap16().toString('utf16le', 2)
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3)
  return buf.toString('utf8')
}

let keysCache = null

export function loadKeys({ reload = false } = {}) {
  if (keysCache && !reload) return keysCache
  const path = keysPath()
  const result = { path, exists: false, keys: {}, error: null, warnings: [] }
  keysCache = result
  if (!existsSync(path)) return result
  result.exists = true

  // A key file the rest of the machine can read is worse than no key file,
  // because it looks like it solved the problem. Windows has no mode bits worth
  // checking here — the profile directory's ACL is the control.
  if (process.platform !== 'win32') {
    try {
      const mode = statSync(path).mode & 0o777
      if (mode & 0o077) {
        result.warnings.push(`${path} is mode ${mode.toString(8)} — readable by other accounts on this machine. Run \`chmod 600\` on it.`)
      }
    } catch { /* stat failing is not worth aborting a review over */ }
  }

  let text
  try {
    text = readTextFile(path)
  } catch (e) {
    result.error = `could not read ${path}: ${e.message}`
    return result
  }

  let lineNo = 0
  for (const raw of text.split(/\r?\n/)) {
    lineNo++
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) {
      // Never echo the line: whatever is malformed about it, it is still a
      // file full of credentials.
      result.warnings.push(`${path}:${lineNo} is not KEY=value — ignored`)
      continue
    }
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim()
    let value = line.slice(eq + 1).trim()
    const quoted = value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    if (quoted) value = value.slice(1, -1)
    if (key) result.keys[key] = value
  }
  return result
}

// { name, value, source } — source is 'env', 'keys-file' or null. Callers that
// report on configuration use the source; callers that authenticate use the
// value and nothing else.
export function secret(name) {
  if (!name) return { name, value: null, source: null }
  if (process.env[name]) return { name, value: process.env[name], source: 'env' }
  const file = loadKeys()
  if (file.keys[name]) return { name, value: file.keys[name], source: 'keys-file' }
  return { name, value: null, source: null }
}

// First name that resolves, so a plugin can keep honouring a legacy variable
// without preferring it.
export function secretAny(...names) {
  for (const n of names) {
    const s = secret(n)
    if (s.value) return s
  }
  return { name: names[0] || null, value: null, source: null }
}

// Upsert one key, preserving comments, order and everything else in the file.
// The value never passes through a shell: `keys.mjs --set` pipes it in on
// stdin, so it stays out of shell history and out of an agent transcript.
export function writeKey(name, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${name}" is not a valid environment variable name`)
  if (/[\r\n]/.test(value)) throw new Error('a key value cannot contain a newline')
  const path = keysPath()
  mkdirSync(dirname(path), { recursive: true })

  const lines = existsSync(path) ? readTextFile(path).split(/\r?\n/) : []
  const line = `${name}=${value}`
  let replaced = false
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 1) continue
    if (t.slice(0, eq).replace(/^export\s+/, '').trim() !== name) continue
    lines[i] = line
    replaced = true
    break
  }
  if (!replaced) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
    lines.push(line)
  }

  // Write restrictively from the first byte rather than fixing the mode after —
  // the gap between the two is exactly when a secret is world-readable.
  writeFileSync(path, lines.join('\n').replace(/\n*$/, '\n'), { encoding: 'utf8', mode: 0o600 })
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600)
    } catch { /* best effort on filesystems without mode bits */ }
  }
  keysCache = null
  return { path, name, replaced }
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
  const token = secretAny(tokenEnv, 'HARVEST_REVIEW_TOKEN')
  const account = secretAny(accountEnv, 'HARVEST_REVIEW_ACCOUNT_ID')
  return {
    token: token.value,
    accountId: account.value,
    tokenEnv,
    accountEnv,
    // Where each came from, for doctor. Never the values.
    source: { token: token.source, accountId: account.source },
  }
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

// --- BambooHR ------------------------------------------------------------
//
// The one thing Harvest cannot tell you is whether a quiet week was a quiet
// week or a holiday. Without it, `no-trace` fires on every person who took
// leave and forgot to log it as absence, and a manager reading the report is
// being asked to chase people about their own vacations. That is the failure
// this source exists to prevent, so its absence must degrade loudly.
//
// Auth is HTTP Basic with the API key as the username and any string as the
// password — Bamboo's own documented convention, odd as it looks.

export function bambooCredentials(cfg) {
  const apiKeyEnv = cfg?.bamboo?.apiKeyEnv || 'BAMBOO_API_KEY'
  const subdomainEnv = cfg?.bamboo?.subdomainEnv || 'BAMBOO_SUBDOMAIN'
  const key = secret(apiKeyEnv)
  // The subdomain is not a secret — it is the company's Bamboo URL — so the
  // config is its home and the variable is only a fallback.
  const fromConfig = cfg?.bamboo?.subdomain || null
  const fromEnv = secret(subdomainEnv)
  return {
    apiKey: key.value,
    subdomain: fromConfig || fromEnv.value,
    apiKeyEnv,
    subdomainEnv,
    enabled: cfg?.bamboo?.enabled !== false,
    source: { apiKey: key.source, subdomain: fromConfig ? 'config' : fromEnv.source },
  }
}

const BAMBOO_BASE = process.env.HARVEST_REVIEW_BAMBOO_BASE || 'https://api.bamboohr.com/api/gateway.php'

export async function bambooGet(path, { apiKey, subdomain }) {
  if (!apiKey || !subdomain) return { ok: false, error: 'BambooHR is not configured (missing API key or subdomain)' }
  const url = `${BAMBOO_BASE}/${encodeURIComponent(subdomain)}/v1${path}`
  let res
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:x`).toString('base64')}`,
        Accept: 'application/json',
        'User-Agent': 'harvest-review (claude-code plugin)',
      },
    })
  } catch (e) {
    return { ok: false, error: `network error: ${e.message}` }
  }
  if (res.status === 401) {
    return { ok: false, status: 401, error: 'BambooHR rejected the API key (401) — check the key, and that it belongs to an account that has not been deactivated' }
  }
  if (res.status === 403) {
    return {
      ok: false,
      status: 403,
      error:
        'BambooHR returned 403 — the key authenticated but the user behind it lacks permission for this data. Time off for other employees needs a role that can see it; a self-service key sees only its own.',
    }
  }
  if (res.status === 404) {
    return { ok: false, status: 404, error: `BambooHR returned 404 — "${subdomain}" is probably not the company subdomain (it is the first label of the Bamboo URL, e.g. "acme" in acme.bamboohr.com)` }
  }
  if (res.status === 429) {
    return { ok: false, status: 429, error: 'BambooHR rate limited the request', retryAfter: Number(res.headers.get('retry-after') || 10) }
  }
  if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
  const text = await res.text()
  if (!text.trim()) return { ok: true, data: [] }
  try {
    return { ok: true, data: JSON.parse(text) }
  } catch {
    // Bamboo answers some misconfigurations with an HTML error page and a 200.
    return { ok: false, error: 'BambooHR returned a non-JSON body — usually a wrong subdomain or an expired key' }
  }
}
