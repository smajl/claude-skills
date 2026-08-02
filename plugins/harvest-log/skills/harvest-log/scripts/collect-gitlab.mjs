#!/usr/bin/env node
// Collect GitLab activity for a date range via `glab api`: pushes, MRs opened /
// merged / approved, issue transitions, and — the part git can't see — review
// comments and diff notes.
//
//   node collect-gitlab.mjs --from 2026-07-29 --to 2026-07-29 [--config path]

import { readFileSync } from 'node:fs'
import { dayAfter, dayBefore, dayWindow, parseArgs, prune, readConfig, resolveDayStartHour, resolveTimezone, run, emit, fail, ticketKeys, withinWindow } from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const cfg = args.config ? JSON.parse(readFileSync(args.config, 'utf8')) : readConfig()
if (!cfg) fail('No config found. Run the harvest-log setup first.')
if (!args.from) fail('--from is required (YYYY-MM-DD)')

const from = String(args.from)
const to = String(args.to || args.from)
const tz = args.tz ? String(args.tz) : resolveTimezone(cfg)
const startHour = args['day-start-hour'] !== undefined ? Number(args['day-start-hour']) : resolveDayStartHour(cfg)
const window = dayWindow(from, to, tz, startHour)
const full = Boolean(args.full)
const pattern = cfg.ticketPattern
const host = cfg.sources?.gitlab?.host

function api(path) {
  const argv = ['api']
  if (host) argv.push('--hostname', host)
  argv.push(path)
  const r = run('glab', argv)
  if (!r.ok) return { ok: false, error: r.error }
  try {
    return { ok: true, data: JSON.parse(r.out) }
  } catch {
    return { ok: false, error: 'unparseable glab response' }
  }
}

const auth = run('glab', ['auth', 'status'])
if (!/Logged in/i.test(`${auth.out || ''}${auth.err || ''}${auth.error || ''}`)) {
  fail('glab is not authenticated — run `glab auth login`')
}

// GitLab's after/before on /events are exclusive *UTC dates*, while the window
// we actually want is a local day — which for a UTC+2 user starts at 22:00 UTC
// the previous day. Widen by two days each side so the API can't clip an edge,
// then filter precisely on the created_at instant.
// Pagination stops at maxPages so a pathological account can't spin forever.
// Hitting that stop means the day is genuinely under-reported, which is worth
// saying out loud rather than quietly returning a thinner day.
const maxPages = Number(args['max-pages'] || 5)
const events = []
let truncated = false
for (let page = 1; ; page++) {
  if (page > maxPages) {
    truncated = true
    break
  }
  const r = api(`events?after=${dayBefore(from, 2)}&before=${dayAfter(to, 2)}&per_page=100&page=${page}`)
  if (!r.ok) fail(`glab events failed: ${r.error}`)
  if (!Array.isArray(r.data) || r.data.length === 0) break
  events.push(...r.data)
  if (r.data.length < 100) break
}

const projectCache = new Map()
function projectPath(id) {
  if (!id) return null
  if (projectCache.has(id)) return projectCache.get(id)
  const r = api(`projects/${id}`)
  const path = r.ok ? r.data.path_with_namespace : String(id)
  projectCache.set(id, path)
  return path
}

const normalized = events.filter((e) => withinWindow(e.created_at, window)).map((e) => {
  const note = e.note || null
  const title = e.target_title || e.push_data?.commit_title || null
  const ref = e.push_data?.ref || null
  return {
    at: e.created_at,
    action: e.action_name, // pushed to, opened, accepted, approved, commented on, closed
    targetType: note ? `${e.target_type || 'Note'}` : e.target_type,
    title,
    project: projectPath(e.project_id),
    ref,
    commitCount: e.push_data?.commit_count ?? null,
    url: e.target_iid && e.target_type === 'MergeRequest'
      ? `${projectPath(e.project_id)}!${e.target_iid}`
      : null,
    noteExcerpt: note ? String(note.body || '').replace(/\s+/g, ' ').slice(0, 240) : null,
    tickets: ticketKeys([title, ref, note?.body].filter(Boolean).join(' '), pattern),
  }
})

// Roll up into the shapes that actually map onto billable lines.
const summary = {
  pushes: normalized.filter((e) => /pushed/i.test(e.action)).length,
  mrsOpened: normalized.filter((e) => e.action === 'opened' && e.targetType === 'MergeRequest').length,
  mrsMerged: normalized.filter((e) => e.action === 'accepted').length,
  approvals: normalized.filter((e) => /approved/i.test(e.action)).length,
  comments: normalized.filter((e) => /commented/i.test(e.action)).length,
}

// Reviews are the easiest activity to under-log: surface them grouped by MR.
//
// `first` / `last` carry the group's instants, exactly as pushes[] does.
// Without them a review is invisible to build-timeline.mjs, and reviewing is
// precisely the activity that fills the gaps between commits — an approval
// dropped from the clock can split one continuous stretch of work into two
// sessions and lose the time between them.
const reviewsByMr = {}
for (const e of normalized) {
  if (!/commented|approved/i.test(e.action)) continue
  const key = e.title || e.url || 'unknown'
  reviewsByMr[key] ??= { title: e.title, project: e.project, comments: 0, approved: false, tickets: e.tickets, excerpts: [], first: e.at, last: e.at }
  if (/approved/i.test(e.action)) reviewsByMr[key].approved = true
  else reviewsByMr[key].comments++
  if (e.noteExcerpt && reviewsByMr[key].excerpts.length < 3) reviewsByMr[key].excerpts.push(e.noteExcerpt)
  if (e.at < reviewsByMr[key].first) reviewsByMr[key].first = e.at
  if (e.at > reviewsByMr[key].last) reviewsByMr[key].last = e.at
}

// Pushes roll up by branch: ten pushes to one branch are one piece of work,
// and the individual events say nothing the local git collector doesn't say
// better.
const pushesByRef = {}
for (const e of normalized) {
  if (!/pushed/i.test(e.action)) continue
  const key = `${e.project}@${e.ref || '?'}`
  pushesByRef[key] ??= { project: e.project, ref: e.ref, pushes: 0, commits: 0, tickets: e.tickets, first: e.at, last: e.at }
  const p = pushesByRef[key]
  p.pushes++
  p.commits += e.commitCount || 0
  if (e.at < p.first) p.first = e.at
  if (e.at > p.last) p.last = e.at
}

const isReview = (e) => /commented|approved/i.test(e.action)
const isPush = (e) => /pushed/i.test(e.action)

// MR lifecycle events carry the titles that become note text.
const mrs = normalized
  .filter((e) => !isReview(e) && !isPush(e) && e.targetType === 'MergeRequest')
  .map((e) => prune({ at: e.at, action: e.action, project: e.project, title: e.title, url: e.url, tickets: e.tickets }))

// Everything else (issues, milestones, joins) — kept, but one line each.
const other = normalized
  .filter((e) => !isReview(e) && !isPush(e) && e.targetType !== 'MergeRequest')
  .map((e) => prune({ at: e.at, action: e.action, targetType: e.targetType, project: e.project, title: e.title, tickets: e.tickets }))

emit(prune({
  ok: true,
  source: 'gitlab',
  from,
  to,
  window,
  user: cfg.identity?.gitlabUsername || null,
  // Non-null only when the page cap cut the feed short. Say so in the
  // proposal's footer — the day's evidence is incomplete.
  truncated: truncated || null,
  truncatedNote: truncated
    ? `stopped after ${maxPages} pages (${events.length} events); re-run with --max-pages to see the rest`
    : null,
  summary,
  reviews: Object.values(reviewsByMr),
  pushes: Object.values(pushesByRef),
  mrs,
  other,
  // The rollups above cover every event; the raw feed is opt-in for debugging.
  events: full ? normalized : null,
}))
