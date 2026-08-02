#!/usr/bin/env node
// Build a per-person, per-day picture of GitLab activity for the review period.
//
//   node collect-gitlab-team.mjs --from 2026-07-01 --to 2026-07-31
//   node collect-gitlab-team.mjs --from 2026-07-01 --to 2026-07-31 --refresh
//
// Reads *project* event streams rather than per-user ones, and this is the
// whole trick: `/projects/:id/events` returns every member's activity in one
// paginated feed, so one fetch covers the entire team for the entire period.
// Per-user feeds would be one fetch per person, and — worse — `/users/:id/events`
// shows a non-admin only what is public, which for a private group is nothing
// at all. A team that looks idle because of a permissions quirk is precisely
// the wrong input to a review, so the per-user path is only a fallback and it
// labels itself as one.
//
// Absence of activity is never proof of absence of work: design, pairing,
// debugging, support and meetings leave no trace here. The scanner treats a
// quiet day as a question, and this collector's job is only to answer it
// consistently.

import { existsSync, statSync } from 'node:fs'
import {
  cachePath, dayAfter, dayBefore, emit, fail, isDate, parseArgs, readConfig, readJson,
  run, ticketKeys, writeCache,
} from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const cfg = readConfig()
if (!cfg) fail('No config found. Run the harvest-review setup first.')
if (!isDate(args.from)) fail('--from is required (YYYY-MM-DD)')

const from = String(args.from)
const to = isDate(args.to) ? String(args.to) : from
const host = cfg.gitlab?.host || null
const pattern = cfg.ticketPattern
const maxPages = Number(args['max-pages'] || cfg.gitlab?.maxPagesPerProject || 20)

const name = `gitlab-${from}_${to}.json`
const out = cachePath(name)
if (!args.refresh && existsSync(out)) {
  const cached = readJson(out)
  emit({ ok: true, cache: out, cached: true, fetchedAt: statSync(out).mtime.toISOString(), ...summarize(cached), note: 'served from cache — pass --refresh to refetch' })
  process.exit(0)
}

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

function pagedEvents(scope) {
  const events = []
  let truncated = false
  for (let page = 1; ; page++) {
    if (page > maxPages) {
      truncated = true
      break
    }
    // after/before are exclusive UTC dates; widen by a day each side and filter
    // on the instant afterwards.
    const r = api(`${scope}/events?after=${dayBefore(from, 2)}&before=${dayAfter(to, 2)}&per_page=100&page=${page}`)
    if (!r.ok) return { ok: false, error: r.error, events, truncated }
    if (!Array.isArray(r.data) || r.data.length === 0) break
    events.push(...r.data)
    if (r.data.length < 100) break
  }
  return { ok: true, events, truncated }
}

// Which projects to sweep: an explicit list wins, otherwise every non-archived
// project under the configured groups.
const projects = []
const errors = []
for (const p of cfg.gitlab?.projects || []) projects.push({ ref: encodeURIComponent(p), label: p })
for (const g of cfg.gitlab?.groups || []) {
  const r = api(`groups/${encodeURIComponent(g)}/projects?per_page=100&archived=false&include_subgroups=true`)
  if (!r.ok) {
    errors.push(`group ${g}: ${r.error}`)
    continue
  }
  for (const p of r.data) projects.push({ ref: String(p.id), label: p.path_with_namespace })
}

const byUser = {}
const seenEventIds = new Set()
const truncatedProjects = []

// A project's own timezone-free view: keep an event when its instant falls in
// [from 00:00, to+1 00:00) local — approximated here as the plain date part of
// created_at, because Harvest's spent_at is a plain date too and comparing an
// instant to a calendar date the other way around invents a precision neither
// side has. Edge-of-midnight work therefore lands on the UTC date, which is
// noted in the report rather than silently corrected.
function recordEvent(e, projectLabel) {
  if (!e.author?.username) return
  if (seenEventIds.has(e.id)) return // a project listed twice, or a group overlap
  seenEventIds.add(e.id)
  const date = String(e.created_at).slice(0, 10)
  if (date < from || date > to) return

  const user = (byUser[e.author.username] ??= { username: e.author.username, name: e.author.name || null, days: {} })
  const day = (user.days[date] ??= { pushes: 0, commits: 0, notes: 0, mrsOpened: 0, mrsMerged: 0, approvals: 0, issues: 0, tickets: [], projects: [], first: null, last: null })

  const action = String(e.action_name || '')
  if (/pushed/i.test(action)) {
    day.pushes++
    day.commits += e.push_data?.commit_count || 0
  } else if (/commented/i.test(action)) day.notes++
  else if (/approved/i.test(action)) day.approvals++
  else if (action === 'opened' && e.target_type === 'MergeRequest') day.mrsOpened++
  else if (/accepted/i.test(action)) day.mrsMerged++
  else if (e.target_type === 'Issue') day.issues++

  const text = [e.target_title, e.push_data?.ref, e.push_data?.commit_title, e.note?.body].filter(Boolean).join(' ')
  for (const k of ticketKeys(text, pattern)) if (!day.tickets.includes(k)) day.tickets.push(k)
  if (!day.projects.includes(projectLabel)) day.projects.push(projectLabel)
  if (!day.first || e.created_at < day.first) day.first = e.created_at
  if (!day.last || e.created_at > day.last) day.last = e.created_at
}

for (const p of projects) {
  const r = pagedEvents(`projects/${p.ref}`)
  if (!r.ok) {
    errors.push(`project ${p.label}: ${r.error}`)
    continue
  }
  if (r.truncated) truncatedProjects.push(p.label)
  for (const e of r.events) recordEvent(e, p.label)
}

// Fallback for anyone the project sweep never saw. Usually means they work in a
// repo nobody listed — which is worth knowing, and worth trying to answer
// before the scanner concludes they did nothing.
const fallbackUsers = []
if (!args['no-fallback']) {
  for (const m of cfg.team || []) {
    if (!m.gitlabUsername || byUser[m.gitlabUsername]) continue
    const r = pagedEvents(`users/${encodeURIComponent(m.gitlabUsername)}`)
    if (!r.ok) {
      errors.push(`user ${m.gitlabUsername}: ${r.error}`)
      continue
    }
    for (const e of r.events) recordEvent({ ...e, author: e.author || { username: m.gitlabUsername } }, 'user-feed')
    fallbackUsers.push(m.gitlabUsername)
  }
}

const data = {
  from,
  to,
  fetchedAt: new Date().toISOString(),
  source: 'gitlab',
  projectsScanned: projects.map((p) => p.label),
  // Named so the report can say "this person's activity is visible only through
  // their own public feed" instead of treating it as equivalent evidence.
  fallbackUsers,
  truncatedProjects,
  errors,
  byUser,
}
writeCache(name, data)

function summarize(d) {
  const perUser = Object.values(d.byUser).map((u) => {
    const days = Object.entries(u.days)
    const total = (f) => days.reduce((a, [, v]) => a + (v[f] || 0), 0)
    return {
      username: u.username,
      activeDays: days.length,
      pushes: total('pushes'),
      commits: total('commits'),
      notes: total('notes'),
      mrsOpened: total('mrsOpened'),
      approvals: total('approvals'),
    }
  }).sort((a, b) => b.activeDays - a.activeDays)
  return {
    from: d.from,
    to: d.to,
    projects: d.projectsScanned?.length || 0,
    users: perUser.length,
    perUser,
    fallbackUsers: d.fallbackUsers?.length ? d.fallbackUsers : null,
    truncatedProjects: d.truncatedProjects?.length ? d.truncatedProjects : null,
    errors: d.errors?.length ? d.errors : null,
  }
}

emit({ ok: true, cache: out, ...summarize(data) })
