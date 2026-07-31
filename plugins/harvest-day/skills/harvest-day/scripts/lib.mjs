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

// Compact by default: the only consumer is a model, and indenting a few
// hundred commits and events spends a large slice of the payload on
// whitespace. Set HARVEST_DAY_PRETTY=1 when reading the output yourself.
export function emit(obj) {
  const pretty = process.env.HARVEST_DAY_PRETTY === '1'
  process.stdout.write(JSON.stringify(obj, null, pretty ? 2 : 0) + '\n')
}

// Drop null / undefined / empty-array / empty-object fields one level deep.
// An absent field reads the same as an empty one to the agent and costs
// nothing to send.
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
export function dayBefore(date, n = 1) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

export function dayAfter(date, n = 1) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// --- Day boundaries -----------------------------------------------------
//
// A "day" means the user's local day, but every source disagrees about how to
// express one: git wants a parseable datetime, GitLab returns UTC instants,
// Confluence CQL is interpreted in UTC. Getting this wrong files late-evening
// and early-morning work on the wrong day, which is exactly the kind of error
// nobody notices in a timesheet. So compute the window once, here, and let
// every collector spend the same bounds.

export function resolveTimezone(cfg) {
  return (
    cfg?.identity?.timezone ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC'
  )
}

// Minutes that `tz` is ahead of UTC at the given instant. Positive east.
function offsetMinutesAt(tz, instant) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  )
  // Some ICU builds render midnight as hour "24" under hour12:false.
  const hour = parts.hour === '24' ? '00' : parts.hour
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(hour), Number(parts.minute), Number(parts.second),
  )
  return Math.round((asIfUtc - instant.getTime()) / 60000)
}

// The UTC instant at which the wall clock in `tz` reads `date` `time`.
// Two passes: the offset depends on the instant we're still solving for, so
// guess with the offset at the naive time and re-solve once. That second pass
// is what makes DST-transition days come out right.
export function zonedToUtc(date, time, tz) {
  const naive = Date.parse(`${date}T${time}Z`)
  let ts = naive - offsetMinutesAt(tz, new Date(naive)) * 60000
  ts = naive - offsetMinutesAt(tz, new Date(ts)) * 60000
  return new Date(ts)
}

function offsetLabel(minutes) {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

// Everything a collector needs to bound an inclusive local day range.
//
//   since / until  offset-bearing ISO, for `git log` (unambiguous regardless
//                  of what timezone the machine itself is in)
//   utcStart       inclusive UTC instant of local midnight on `from`
//   utcEnd         exclusive UTC instant of local midnight after `to`
//   cqlStart/End   the same bounds as Confluence CQL wants them, "YYYY-MM-DD
//                  HH:mm" in UTC — CQL date bounds are UTC, not local
export function dayWindow(from, to, tz) {
  const start = zonedToUtc(from, '00:00:00', tz)
  const end = zonedToUtc(dayAfter(to), '00:00:00', tz)
  const startOffset = offsetMinutesAt(tz, start)
  const endOffset = offsetMinutesAt(tz, new Date(end.getTime() - 1))
  const cql = (d) => d.toISOString().slice(0, 16).replace('T', ' ')
  return {
    tz,
    from,
    to,
    since: `${from}T00:00:00${offsetLabel(startOffset)}`,
    until: `${to}T23:59:59${offsetLabel(endOffset)}`,
    utcStart: start.toISOString(),
    utcEnd: end.toISOString(),
    cqlStart: cql(start),
    cqlEnd: cql(end),
    dstShift: startOffset === endOffset ? null : `${offsetLabel(startOffset)} -> ${offsetLabel(endOffset)}`,
  }
}

// Does an ISO instant (GitLab's `created_at`, a commit's %aI) fall inside the
// window? Compares instants, never date strings — slicing "2026-07-29T22:30Z"
// to its first ten characters answers a question about UTC, not about the
// user's day.
export function withinWindow(iso, window) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return false
  return t >= Date.parse(window.utcStart) && t < Date.parse(window.utcEnd)
}

// Today's date as the user's calendar shows it, not as UTC does.
export function localToday(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}
