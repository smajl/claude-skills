#!/usr/bin/env node
// Collect GitLab activity for a date range via `glab api`: pushes, MRs opened /
// merged / approved, issue transitions, and — the part git can't see — review
// comments and diff notes.
//
//   node collect-gitlab.mjs --from 2026-07-29 --to 2026-07-29 [--config path]

import { readFileSync } from 'node:fs'
import { dayAfter, dayBefore, parseArgs, readConfig, run, emit, fail, ticketKeys } from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const cfg = args.config ? JSON.parse(readFileSync(args.config, 'utf8')) : readConfig()
if (!cfg) fail('No config found. Run the harvest-day setup first.')
if (!args.from) fail('--from is required (YYYY-MM-DD)')

const from = String(args.from)
const to = String(args.to || args.from)
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

// GitLab's after/before on /events are exclusive, so widen by a day each side
// and filter precisely on created_at afterwards.
const events = []
for (let page = 1; page <= 5; page++) {
  const r = api(`events?after=${dayBefore(from)}&before=${dayAfter(to)}&per_page=100&page=${page}`)
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

const inWindow = (iso) => {
  const day = String(iso).slice(0, 10)
  return day >= from && day <= to
}

const normalized = events.filter((e) => inWindow(e.created_at)).map((e) => {
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
const reviewsByMr = {}
for (const e of normalized) {
  if (!/commented|approved/i.test(e.action)) continue
  const key = e.title || e.url || 'unknown'
  reviewsByMr[key] ??= { title: e.title, project: e.project, comments: 0, approved: false, tickets: e.tickets, excerpts: [] }
  if (/approved/i.test(e.action)) reviewsByMr[key].approved = true
  else reviewsByMr[key].comments++
  if (e.noteExcerpt && reviewsByMr[key].excerpts.length < 3) reviewsByMr[key].excerpts.push(e.noteExcerpt)
}

emit({
  ok: true,
  source: 'gitlab',
  from,
  to,
  user: cfg.identity?.gitlabUsername || null,
  summary,
  reviews: Object.values(reviewsByMr),
  events: normalized,
})
