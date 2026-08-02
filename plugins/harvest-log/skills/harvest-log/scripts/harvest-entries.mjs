#!/usr/bin/env node
// Read the user's own Harvest entries through the REST API, and print only what
// a decision is made from.
//
//   node harvest-entries.mjs --from 2026-07-31 --to 2026-07-31   # what's logged
//   node harvest-entries.mjs --catch-up --days 14                # under-target days
//   node harvest-entries.mjs --calibrate --days 90               # setup's medians
//   node harvest-entries.mjs --calibrate --days 90 --evening-days evenings.json
//
// The three modes exist because three phases of the skill each need a different
// summary of the same rows, and none of them needs the rows. `--calibrate` over
// 90 days reads several hundred entries and prints about thirty lines.
//
// Falls back to nothing: when there are no credentials this exits 2 with
// `fallback: "mcp"`, which tells the skill to use the Harvest MCP instead. That
// path works and costs more context; it is not an error.
//
// Everything past the first request ends through finish() rather than
// process.exit() — see lib.mjs for why that distinction is load-bearing on
// Windows.

import { readFileSync } from 'node:fs'
import { credentials, hasCredentials, missingCredentialsMessage, paged } from './harvest-api.mjs'
import { dayAfter, dayBefore, fail, finish, localToday, parseArgs, prune, readConfig, resolveDayStartHour, resolveTimezone } from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const cfg = readConfig()
if (!cfg) fail('No config found. Run the harvest-log setup first.')

const round = (n, to_ = 0.01) => Math.round(n / to_) * to_
const sum = (xs) => xs.reduce((a, b) => a + b, 0)
const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}
const isWeekendDate = (d) => {
  const w = new Date(`${d}T00:00:00Z`).getUTCDay()
  return w === 0 || w === 6
}

await main()

async function main() {
  if (!hasCredentials(cfg)) {
    return finish({ ok: false, fallback: 'mcp', error: missingCredentialsMessage(cfg) }, 2)
  }
  const creds = credentials(cfg)

  const tz = resolveTimezone(cfg)
  const today = localToday(tz, resolveDayStartHour(cfg))
  const userId = cfg.identity?.harvestUserId || null

  const mode = args['catch-up'] ? 'catch-up' : args.calibrate ? 'calibrate' : 'list'
  const days = Number(args.days || (mode === 'calibrate' ? 90 : cfg.rules?.catchUpWindowDays || 14))
  const from = String(args.from || dayBefore(today, days - 1))
  const to = String(args.to || today)

  // user_id scopes the request server-side. Without it a manager's token would
  // return the whole team, which is harvest-review's job and not this one's.
  const query = new URLSearchParams({ from, to, per_page: '100' })
  if (userId) query.set('user_id', String(userId))

  const r = await paged(`/time_entries?${query}`, creds, 'time_entries')
  if (!r.ok) return finish({ ok: false, error: `Harvest fetch failed: ${r.error}` }, 1)

  const entries = r.items.map((e) => ({
    id: e.id,
    spentAt: e.spent_date,
    hours: e.hours,
    notes: e.notes || '',
    projectId: e.project?.id ?? null,
    projectName: e.project?.name || null,
    taskId: e.task?.id ?? null,
    taskName: e.task?.name || null,
    billable: e.billable,
    isLocked: e.is_locked || false,
  }))

  const byDay = new Map()
  for (const e of entries) {
    if (!byDay.has(e.spentAt)) byDay.set(e.spentAt, [])
    byDay.get(e.spentAt).push(e)
  }
  const dayTotal = (d) => round(sum((byDay.get(d) || []).map((e) => e.hours)), 0.01)

  // --- list: what is already logged for a day or range -------------------

  if (mode === 'list') {
    return finish({
      ok: true,
      source: 'harvest-api',
      from,
      to,
      userId,
      truncated: r.truncated,
      total: round(sum(entries.map((e) => e.hours)), 0.01),
      perDay: [...byDay.keys()].sort().map((d) => ({ date: d, hours: dayTotal(d) })),
      entries: entries.map((e) =>
        prune({
          id: e.id,
          date: e.spentAt,
          hours: e.hours,
          project: e.projectName,
          task: e.taskName,
          note: e.notes.slice(0, 120),
          locked: e.isLocked || null,
        }),
      ),
    })
  }

  // --- catch-up: which recent workdays are empty or thin -----------------

  if (mode === 'catch-up') {
    const skipWeekends = cfg.rules?.skipWeekends !== false
    const target = (d) => {
      const t = cfg.harvest?.calibration?.dayTotals || {}
      if (isWeekendDate(d)) return t.weekend ?? null
      return t.weekday ?? cfg.harvest?.targetHoursPerDay ?? 8
    }
    const all = []
    for (let d = from; d <= to; d = dayAfter(d)) all.push(d)
    const rows = all.map((d) => {
      const hours = dayTotal(d)
      const t = target(d)
      return {
        date: d,
        weekday: new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }),
        hours,
        target: t,
        // A weekend with no target of its own is not "under target"; it is a
        // day the user does not normally log, and the skill decides about it
        // from collector evidence rather than from a number nobody measured.
        under: t !== null && hours + 0.001 < t,
        weekend: isWeekendDate(d) || null,
      }
    })
    return finish({
      ok: true,
      source: 'harvest-api',
      mode: 'catch-up',
      from,
      to,
      userId,
      truncated: r.truncated,
      days: rows,
      // The candidate list, already filtered the way Phase 2 filters it.
      // Weekend days drop out only when rules.skipWeekends says so; evidence
      // can still put one back, which is the collectors' call, not this one's.
      candidates: rows.filter((x) => x.under && (!skipWeekends || !x.weekend)).map((x) => x.date),
    })
  }

  // --- calibrate: the medians setup writes into the config ---------------

  // Days on which timestamped evidence ran into the evening. Supplied by the
  // skill from the git/GitLab collectors, because Harvest cannot know it: an
  // entry carries a date and a duration, never a clock. Without the file the
  // two evening fields are omitted rather than guessed.
  let eveningDays = null
  if (args['evening-days']) {
    const raw = JSON.parse(readFileSync(String(args['evening-days']), 'utf8'))
    eveningDays = new Set(Array.isArray(raw) ? raw : raw.days || [])
  }

  const meetingRe = new RegExp(
    String(args['meeting-tasks'] || 'meeting|standup|stand-up|sync|retro|grooming|refinement|1on1|1-1|demo|ceremon'),
    'i',
  )

  const loggedDays = [...byDay.keys()].sort()
  const weekdayDays = loggedDays.filter((d) => !isWeekendDate(d))
  const weekendDays = loggedDays.filter((d) => isWeekendDate(d))
  const eveningOf = (dates) => (eveningDays ? dates.filter((d) => eveningDays.has(d)) : [])
  const wkEvening = eveningOf(weekdayDays)
  const weEvening = eveningOf(weekendDays)

  // Medians over *all* days of a kind, not only the ones without an evening:
  // `weekday` is the figure a day falls back to, so it should describe the
  // population rather than a subset chosen by the thing being measured.
  const medianOf = (dates) => (dates.length ? round(median(dates.map(dayTotal)), 0.01) : null)

  const byTask = new Map()
  for (const e of entries) {
    if (!e.taskId) continue
    if (!byTask.has(e.taskId)) byTask.set(e.taskId, { taskId: e.taskId, taskName: e.taskName, hours: [], notes: [] })
    const t = byTask.get(e.taskId)
    t.hours.push(e.hours)
    if (e.notes) t.notes.push(e.notes)
  }

  const medianHoursByTask = {}
  for (const [taskId, t] of byTask) {
    // Three entries is the floor: below that a "median" is one person's Tuesday.
    if (t.hours.length >= 3) medianHoursByTask[taskId] = round(median(t.hours), 0.01)
  }

  const normalize = (s) =>
    s.toLowerCase().replace(/[a-z][a-z0-9]{1,9}-\d+/gi, '#').replace(/[^a-z0-9#\s]+/g, ' ').replace(/\s+/g, ' ').trim()

  // Recurring phrasings per task — the raw material for learnedRoutes and for
  // describing noteStyle. Five per task, which is enough to see a pattern and
  // short enough to read.
  const notePatterns = [...byTask.values()]
    .map((t) => {
      const counts = new Map()
      for (const n of t.notes) {
        const k = normalize(n).split(' ').slice(0, 6).join(' ')
        if (!k) continue
        if (!counts.has(k)) counts.set(k, { pattern: k, count: 0, sample: n })
        counts.get(k).count++
      }
      return {
        taskId: t.taskId,
        taskName: t.taskName,
        entries: t.hours.length,
        isMeetingTask: meetingRe.test(t.taskName || '') || null,
        top: [...counts.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, 5)
          .map((c) => ({ count: c.count, sample: c.sample.slice(0, 80) })),
      }
    })
    .sort((a, b) => b.entries - a.entries)

  const byProject = new Map()
  for (const e of entries) {
    if (!e.projectId) continue
    if (!byProject.has(e.projectId)) byProject.set(e.projectId, { projectId: e.projectId, projectName: e.projectName, hours: 0, entries: 0 })
    const p = byProject.get(e.projectId)
    p.hours += e.hours
    p.entries++
  }
  const projects = [...byProject.values()].map((p) => ({ ...p, hours: round(p.hours, 0.01) })).sort((a, b) => b.hours - a.hours)

  const workEntriesPerDay = loggedDays.map((d) => (byDay.get(d) || []).filter((e) => !meetingRe.test(e.taskName || '')).length)

  return finish({
    ok: true,
    source: 'harvest-api',
    mode: 'calibrate',
    from,
    to,
    userId,
    truncated: r.truncated,
    entries: entries.length,
    loggedDays: loggedDays.length,
    // Straight into harvest.calibration and its neighbours. Fields that came
    // out of too small a sample are absent rather than fitted to noise — see
    // references/setup.md for the floors.
    suggested: prune({
      defaultProjectId: projects[0]?.projectId ?? null,
      targetHoursPerDay: medianOf(weekdayDays),
      medianHoursByTask,
      medianWorkEntriesPerDay: workEntriesPerDay.length ? median(workEntriesPerDay) : null,
      dayTotals: prune({
        weekday: medianOf(weekdayDays),
        weekdayWithEveningSession: wkEvening.length >= 5 ? medianOf(wkEvening) : null,
        weekend: weekendDays.length >= 3 ? medianOf(weekendDays) : null,
        weekendWithEveningSession: weEvening.length >= 3 ? medianOf(weEvening) : null,
      }),
      computedFrom: today,
    }),
    sampleSizes: {
      weekdayDays: weekdayDays.length,
      weekdayEveningDays: wkEvening.length,
      weekendDays: weekendDays.length,
      weekendEveningDays: weEvening.length,
      eveningDaysSupplied: eveningDays ? eveningDays.size : null,
    },
    // Omitted fields are the ones worth mentioning to the user: each is a
    // measurement the history could not support, not a value that came out zero.
    omitted: prune({
      weekdayWithEveningSession: !eveningDays
        ? 'no --evening-days supplied — run the git/GitLab collectors over the same window and pass the days that ran late'
        : wkEvening.length < 5
          ? `only ${wkEvening.length} weekday evenings in ${days} days (need 5)`
          : null,
      weekend: weekendDays.length < 3 ? `only ${weekendDays.length} weekend days logged (need 3)` : null,
      weekendWithEveningSession: weEvening.length < 3 ? `only ${weEvening.length} weekend evenings (need 3)` : null,
    }),
    projects,
    notePatterns,
  })
}
