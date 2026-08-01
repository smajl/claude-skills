#!/usr/bin/env node
// Merge every timestamped source into one sorted event stream, cut it into
// sessions, and report what the shape of the day implies.
//
// This exists because the merge is the one piece of arithmetic in this skill
// that spans every collector at once — five payloads, three timestamp
// conventions — and doing it by hand in context produces a different answer on
// different runs. Here it is a pure function over the collectors' own output.
//
// It fetches what it can fetch locally (git, GitLab) and takes everything that
// needs an MCP (Slack messages, calendar) through --events. That split is
// deliberate: the script never needs a network credential, so it behaves the
// same whether or not a Slack user token exists.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  readConfig, run, parseArgs, emit, prune, fail,
  resolveTimezone, resolveDayStartHour, dayWindow, localToday,
} from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  gapMinutes: 90,
  eveningHour: 19,
  floorEvents: 3,
  floorSpanMinutes: 15,
}

// --- local wall-clock from an instant -------------------------------------
// Sessions are judged against the user's clock ("did this start after 19:00"),
// never against UTC. An evening in Prague is mid-afternoon in UTC, and a rule
// written on the wrong one silently stops firing for half the year.
function localHour(ms, tz) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', hour12: false,
  }).formatToParts(new Date(ms))
  return Number(p.find((x) => x.type === 'hour').value) % 24
}

function localClock(ms, tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms))
}

function localDate(ms, tz) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms))
  const g = (t) => p.find((x) => x.type === t).value
  return `${g('year')}-${g('month')}-${g('day')}`
}

// --- input ----------------------------------------------------------------

function collectorJson(script, args) {
  const r = run(process.execPath, [join(HERE, script), ...args])
  if (!r.ok) return { ok: false, error: r.error }
  try {
    return JSON.parse(r.out)
  } catch {
    return { ok: false, error: `${script} produced unparseable output` }
  }
}

function gitEvents(git) {
  const out = []
  for (const repo of git.repos || []) {
    for (const c of repo.commits || []) {
      if (!c.date) continue
      out.push({
        t: Date.parse(c.date),
        kind: c.dateUnreliable ? 'squash' : 'commit',
        label: `${repo.name}: ${c.subject || c.sha?.slice(0, 8) || ''}`.trim(),
        repo: repo.name,
      })
    }
  }
  return out
}

function gitlabEvents(gl) {
  const out = []
  const short = (p) => String(p || '').split('/').pop()
  // A push carries first/last instants for a whole branch group. Both are real
  // moments of activity; when they coincide the dedupe below drops one.
  for (const p of gl.pushes || []) {
    for (const key of ['first', 'last']) {
      if (!p[key]) continue
      out.push({
        t: Date.parse(p[key]),
        kind: 'push',
        label: `${short(p.project)} ${p.ref || ''}`.trim(),
        repo: short(p.project),
      })
    }
  }
  for (const m of gl.mrs || []) {
    if (!m.at) continue
    out.push({ t: Date.parse(m.at), kind: `mr-${m.action}`, label: m.title || m.url || '', repo: short(m.project) })
  }
  for (const o of gl.other || []) {
    if (!o.at) continue
    out.push({ t: Date.parse(o.at), kind: 'gitlab', label: o.title || o.action || '', repo: short(o.project) })
  }
  // Review activity is what fills the gaps between commits; without it a day
  // of reviewing reads as idle and long stretches fragment into sessions.
  for (const r of gl.reviews || []) {
    for (const key of ['first', 'last']) {
      if (!r[key]) continue
      out.push({ t: Date.parse(r[key]), kind: 'review', label: r.title || '', repo: short(r.project) })
    }
  }
  return out
}

// Supplied by the caller for anything behind an MCP. Two shapes: a point
// ({t}) or a span ({start,end}). Spans are meetings — exclusive ground truth,
// never sessionised, used only to detect conflicts.
function readSupplied(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e) {
    fail(`--events ${path} could not be read: ${e.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    fail(`--events ${path} is not valid JSON: ${e.message}`)
  }
  const list = Array.isArray(parsed) ? parsed : parsed.events
  if (!Array.isArray(list)) fail('--events must be a JSON array, or an object with an "events" array')

  const points = []
  const spans = []
  list.forEach((e, i) => {
    const where = `--events[${i}]`
    if (e.start && e.end) {
      const s = Date.parse(e.start)
      const f = Date.parse(e.end)
      if (Number.isNaN(s) || Number.isNaN(f)) fail(`${where}: unparseable start/end`)
      if (f < s) fail(`${where}: end precedes start`)
      spans.push({ start: s, end: f, kind: e.kind || 'meeting', label: e.label || '' })
      return
    }
    const t = Date.parse(e.t ?? e.ts ?? e.time)
    if (Number.isNaN(t)) fail(`${where}: needs a parseable "t" (or "start"+"end")`)
    points.push({ t, kind: e.kind || 'event', label: e.label || '', repo: e.repo })
  })
  return { points, spans }
}

// --- sessionising ---------------------------------------------------------

function sessionise(points, gapMs) {
  if (!points.length) return []
  const out = []
  let cur = { start: points[0].t, end: points[0].t, events: [points[0]] }
  for (const p of points.slice(1)) {
    if (p.t - cur.end <= gapMs) {
      cur.end = p.t
      cur.events.push(p)
    } else {
      out.push(cur)
      cur = { start: p.t, end: p.t, events: [p] }
    }
  }
  out.push(cur)
  return out
}

// --- main -----------------------------------------------------------------

const args = parseArgs(process.argv.slice(2))
const cfg = readConfig() || {}
const tz = args.tz || resolveTimezone(cfg)
const startHour = args['day-start-hour'] !== undefined
  ? Number(args['day-start-hour'])
  : resolveDayStartHour(cfg)

const num = (flag, cfgVal, dflt) => {
  const v = args[flag] !== undefined ? Number(args[flag]) : (cfgVal ?? dflt)
  return Number.isFinite(v) && v >= 0 ? v : dflt
}
const rules = cfg.rules || {}
const params = {
  gapMinutes: num('gap', rules.sessionGapMinutes, DEFAULTS.gapMinutes),
  eveningHour: num('evening-hour', rules.eveningSessionHour, DEFAULTS.eveningHour),
  floorEvents: num('floor-events', rules.eveningFloorEvents, DEFAULTS.floorEvents),
  floorSpanMinutes: num('floor-span', rules.eveningFloorSpanMinutes, DEFAULTS.floorSpanMinutes),
}

const from = args.from || localToday(tz, startHour)
const to = args.to || from
const window = dayWindow(from, to, tz, startHour)

const passthrough = ['--from', from, '--to', to, '--tz', tz, '--day-start-hour', String(startHour)]
const notes = []
let points = []

if (cfg.sources?.git?.enabled !== false) {
  const git = collectorJson('collect-git.mjs', passthrough)
  if (git.ok === false) notes.push(`git collector failed: ${git.error}`)
  else points.push(...gitEvents(git))
}

if (cfg.sources?.gitlab?.enabled !== false) {
  const gl = collectorJson('collect-gitlab.mjs', passthrough)
  if (gl.ok === false) notes.push(`gitlab collector failed: ${gl.error}`)
  else {
    points.push(...gitlabEvents(gl))
    if (gl.truncated) notes.push('gitlab reported truncated results — the timeline is incomplete')
    // A review group carries the group's first and last instants, not one per
    // comment, so a long threaded review appears as two points rather than a
    // stretch. That understates it, and understating is the safe direction.
    const untimed = (gl.reviews || []).filter((r) => !r.first).length
    if (untimed) notes.push(`${untimed} reviewed MR(s) predate the timestamped reviews[] rollup and are absent from the timeline`)
  }
}

let spans = []
if (args.events) {
  const supplied = readSupplied(args.events)
  points.push(...supplied.points)
  spans = supplied.spans
} else {
  notes.push('no --events supplied: Slack messages and calendar meetings are not in this timeline')
}

// Keep only what belongs to the window, then dedupe exact (instant, kind)
// pairs — a push whose first and last coincide, a commit seen in two checkouts.
const lo = Date.parse(window.utcStart)
const hi = Date.parse(window.utcEnd)
const seen = new Set()
points = points
  .filter((p) => Number.isFinite(p.t) && p.t >= lo && p.t < hi)
  .sort((a, b) => a.t - b.t)
  .filter((p) => {
    const k = `${p.t}|${p.kind}|${p.label}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

const sessions = sessionise(points, params.gapMinutes * 60000).map((s) => {
  const kinds = {}
  for (const e of s.events) kinds[e.kind] = (kinds[e.kind] || 0) + 1
  const h = localHour(s.start, tz)
  return {
    start: new Date(s.start).toISOString(),
    end: new Date(s.end).toISOString(),
    startLocal: localClock(s.start, tz),
    endLocal: localClock(s.end, tz),
    minutes: Math.round((s.end - s.start) / 60000),
    events: s.events.length,
    kinds,
    // After midnight but before the day boundary is still "evening" — it is
    // the same stretch of work, which is the whole point of dayStartHour.
    evening: h >= params.eveningHour || h < startHour,
    _start: s.start,
    _end: s.end,
  }
})

const clean = ({ _start, _end, ...s }) => s

// The floor is applied to ALL evening evidence together, not to each session.
// The question being answered is "did this day extend into the evening", and an
// evening of work interrupted by a two-hour dinner is still an evening of work —
// judging the last session alone would reject it for being short. Sessions still
// describe the shape; this decides whether the target moves.
const eveningEvents = points.filter((p) => {
  const h = localHour(p.t, tz)
  return h >= params.eveningHour || h < startHour
})

const eveningSpanMinutes = eveningEvents.length
  ? Math.round((eveningEvents[eveningEvents.length - 1].t - eveningEvents[0].t) / 60000)
  : 0

const eveningSummary = eveningEvents.length
  ? {
    startLocal: localClock(eveningEvents[0].t, tz),
    endLocal: localClock(eveningEvents[eveningEvents.length - 1].t, tz),
    start: new Date(eveningEvents[0].t).toISOString(),
    end: new Date(eveningEvents[eveningEvents.length - 1].t).toISOString(),
    events: eveningEvents.length,
    minutes: eveningSpanMinutes,
    kinds: eveningEvents.reduce((a, e) => ({ ...a, [e.kind]: (a[e.kind] || 0) + 1 }), {}),
    sessions: sessions.filter((s) => s.evening).length,
  }
  : null

const clearsFloor = Boolean(eveningSummary)
  && eveningSummary.events >= params.floorEvents
  && eveningSummary.minutes >= params.floorSpanMinutes

const eveningSession = clearsFloor ? { ...eveningSummary, clearsFloor: true } : null

// A burst below the floor still says the day didn't end at 18:00. Report it
// separately so the proposal can mention it without moving the target.
const eveningBelowFloor = !clearsFloor && eveningSummary
  ? { ...eveningSummary, clearsFloor: false }
  : null

// A point event inside a meeting means the user was doing something else for
// part of it. This is the one conflict the calendar cannot see on its own.
const meetingOverlaps = []
for (const m of spans) {
  const inside = points.filter((p) => p.t >= m.start && p.t <= m.end)
  if (inside.length) {
    meetingOverlaps.push({
      meeting: m.label,
      meetingLocal: `${localClock(m.start, tz)}–${localClock(m.end, tz)}`,
      events: inside.length,
      at: inside.slice(0, 4).map((p) => `${localClock(p.t, tz)} ${p.kind}`),
    })
  }
}

const afterMidnight = points
  .filter((p) => localDate(p.t, tz) !== localDate(p.t - startHour * 3600000, tz))
  .map((p) => `${localClock(p.t, tz)} ${p.kind} — ${p.label}`.trim())

const measuredMinutes = sessions.reduce((a, s) => a + s.minutes, 0)

emit(prune({
  ok: true,
  source: 'timeline',
  from,
  to,
  window,
  params: { ...params, dayStartHour: startHour },
  eventCount: points.length,
  measuredHours: Math.round((measuredMinutes / 60) * 100) / 100,
  spanHours: points.length
    ? Math.round(((points[points.length - 1].t - points[0].t) / 3600000) * 100) / 100
    : 0,
  firstLocal: points.length ? localClock(points[0].t, tz) : null,
  lastLocal: points.length ? localClock(points[points.length - 1].t, tz) : null,
  sessions: sessions.map(clean),
  eveningSession,
  eveningBelowFloor,
  meetingOverlaps,
  afterMidnight,
  notes,
}))
