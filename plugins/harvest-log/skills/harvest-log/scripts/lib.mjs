// Shared helpers for the harvest-log collectors.
// No dependencies — plain Node, works on Windows / macOS / Linux.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'

export function configDir() {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(base, 'harvest-log')
}

// Where the config lived when this plugin was called harvest-day. Read-only:
// nothing new is ever written here, but a config that predates the rename is
// still a perfectly good config and shouldn't strand the user in setup again.
export function legacyConfigDir() {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(base, 'harvest-day')
}

export function configPath() {
  return join(configDir(), 'config.json')
}

export function legacyConfigPath() {
  return join(legacyConfigDir(), 'config.json')
}

// The path actually in force: the current one if it exists, else the legacy one
// if it does, else the current one (so "missing" reports the path setup will
// write). doctor.mjs turns the legacy case into a warning with the move command.
export function activeConfigPath() {
  if (existsSync(configPath())) return configPath()
  if (existsSync(legacyConfigPath())) return legacyConfigPath()
  return configPath()
}

export function usingLegacyConfig() {
  return !existsSync(configPath()) && existsSync(legacyConfigPath())
}

export function readConfig() {
  const p = activeConfigPath()
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf8'))
}

export function writeConfig(cfg) {
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  return configPath()
}

// Windows only: find what a bare command name actually refers to, the way the
// shell would — walk PATH against PATHEXT. PATHEXT lists .EXE before .CMD, so
// a real executable wins over a shim of the same name.
//
// Doing this ourselves is what lets us avoid `shell: true`. Node deprecated
// passing an args array alongside it (DEP0190) because the arguments are
// concatenated into a command line rather than escaped, and the deprecation is
// right: routing through cmd.exe re-parses `&` and `|` out of argument values.
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

// Run a command, capturing stdout and stderr separately. Never throws —
// failures come back as { ok: false, error } so one broken repo or a logged-out
// CLI can't abort a whole collection run.
//
// `err` matters: several CLIs (notably `glab auth status`) exit 0 and write
// their real output to stderr, so callers that only read stdout see nothing.
export function run(cmd, args, opts = {}) {
  const base = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }

  if (process.platform !== 'win32') return spawnResult(spawnSync(cmd, args, base))

  const resolved = resolveWindowsCommand(cmd)
  if (!resolved) return { ok: false, error: `${cmd} not found on PATH` }

  // git, glab and gh are native binaries; spawning the resolved path directly
  // means no shell, no command line to escape, and no deprecation.
  const ext = extname(resolved).toLowerCase()
  if (ext !== '.cmd' && ext !== '.bat') return spawnResult(spawnSync(resolved, args, base))

  // A batch shim (scoop, chocolatey) can only be started through cmd.exe.
  // `/s` is load-bearing: without it cmd re-parses the arguments and a value
  // containing `&` or `|` would execute. With it, arguments stay literal.
  // The one thing /s cannot survive is a space in the program path, and every
  // alternative quoting reintroduces the injection — so refuse instead, rather
  // than run something unsafe.
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

// Compact by default: the only consumer is a model, and indenting a few
// hundred commits and events spends a large slice of the payload on
// whitespace. Set HARVEST_LOG_PRETTY=1 when reading the output yourself.
export function emit(obj) {
  const pretty = process.env.HARVEST_LOG_PRETTY === '1' || process.env.HARVEST_DAY_PRETTY === '1'
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

// Default key shape: HUME-1234, ENG-77. Overridable via config.ticketPattern.
export function ticketKeys(text, pattern) {
  if (!text) return []
  const re = new RegExp(pattern || '[A-Z][A-Z0-9]{1,9}-\\d+', 'g')
  return [...new Set(String(text).match(re) || [])]
}

// "git@gitlab.com:acme/web.git" -> "acme/web". The same value GitLab reports
// as path_with_namespace, so a local repo and a GitLab event stream can be
// recognised as the same thing and not counted twice.
export function repoSlug(remote) {
  if (!remote) return null
  const s = String(remote).trim().replace(/\/+$/, '').replace(/\.git$/, '')
  // scp-like: [user@]host:group/sub/proj
  let m = s.match(/^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/)
  if (m) return m[2].replace(/^\/+/, '') || null
  // url form: scheme://[user@]host[:port]/group/sub/proj
  m = s.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i)
  if (m) return m[1].replace(/^\/+/, '') || null
  return null
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

// The hour at which one working day gives way to the next. Work at 00:30
// belongs to the evening it continued from, not to the morning it technically
// landed in, so the boundary sits at 03:00 rather than at midnight.
//
// This shifts the boundary; it does not overlap two days. Day D runs
// [D 03:00, D+1 03:00) and day D+1 starts where it ends. An overlap — D
// reaching into D+1 while D+1 still began at midnight — would put the small
// hours in both windows and bill them twice, which is the one outcome a
// timesheet must never produce.
//
// Set rules.dayStartHour to 0 for literal midnight days.
export const DEFAULT_DAY_START_HOUR = 3

export function resolveDayStartHour(cfg) {
  const h = cfg?.rules?.dayStartHour
  if (h === undefined || h === null) return DEFAULT_DAY_START_HOUR
  const n = Number(h)
  // Past midday it stops being "late night" and starts silently moving whole
  // afternoons onto the wrong day, so refuse rather than honour it.
  if (!Number.isInteger(n) || n < 0 || n > 11) return DEFAULT_DAY_START_HOUR
  return n
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

// An instant as an offset-bearing local ISO string — "2026-07-31T03:00:00+02:00".
// Derived from the real offset at that instant rather than assembled from date
// parts, so it stays correct across a DST boundary.
function formatZoned(instant, tz) {
  const off = offsetMinutesAt(tz, instant)
  return new Date(instant.getTime() + off * 60000).toISOString().slice(0, 19) + offsetLabel(off)
}

// Everything a collector needs to bound an inclusive local day range.
//
//   since / until  offset-bearing ISO, for `git log` (unambiguous regardless
//                  of what timezone the machine itself is in)
//   utcStart       inclusive UTC instant at which `from` begins
//   utcEnd         exclusive UTC instant at which `to` ends
//   cqlStart/End   the same bounds as Confluence CQL wants them, "YYYY-MM-DD
//                  HH:mm" in UTC — CQL date bounds are UTC, not local
//   startHour      the boundary in play; 3 means the day runs 03:00 to 03:00
//   spillsPastMidnight  true when the window reaches into the next calendar
//                  date, which is worth saying out loud in a proposal footer
//
// `startHour` shifts both ends together — see resolveDayStartHour. The two
// ends must move as one: raising only the far end would overlap the next day
// and count the small hours twice.
export function dayWindow(from, to, tz, startHour = 0) {
  const at = `${String(startHour).padStart(2, '0')}:00:00`
  const start = zonedToUtc(from, at, tz)
  const end = zonedToUtc(dayAfter(to), at, tz)
  const startOffset = offsetMinutesAt(tz, start)
  const endOffset = offsetMinutesAt(tz, end)
  const cql = (d) => d.toISOString().slice(0, 16).replace('T', ' ')

  // Detect the short and long days by measuring the window, not by comparing
  // its two endpoints' offsets. A non-midnight boundary can land exactly on
  // the transition — a 03:00 day boundary in Europe/Prague sits right at the
  // spring-forward instant — leaving both endpoints on the same offset while
  // the day between them is still only 23 hours long.
  const nominalHours =
    24 * Math.round((Date.parse(`${dayAfter(to)}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000)
  const actualHours = (end.getTime() - start.getTime()) / 3600_000
  return {
    tz,
    from,
    to,
    startHour,
    since: formatZoned(start, tz),
    // Inclusive: git's --until is, and one second short of the exclusive end
    // is the last instant the day contains.
    until: formatZoned(new Date(end.getTime() - 1000), tz),
    utcStart: start.toISOString(),
    utcEnd: end.toISOString(),
    cqlStart: cql(start),
    cqlEnd: cql(end),
    spillsPastMidnight: startHour > 0 || null,
    dstShift:
      actualHours === nominalHours
        ? null
        : `${offsetLabel(startOffset)} -> ${offsetLabel(endOffset)} (${actualHours}h, not ${nominalHours}h)`,
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

// Today's date as the user's calendar shows it, not as UTC does — and, with a
// non-zero `startHour`, as their *working* day sees it. At 01:00 on the 1st
// with the boundary at 03:00, the working day is still the 31st, so "log
// today" reaches for the session the user is actually still in rather than
// opening an empty new one.
export function localToday(tz, startHour = 0) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() - startHour * 3600_000))
}
