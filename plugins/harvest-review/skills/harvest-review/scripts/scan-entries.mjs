#!/usr/bin/env node
// The detection pass. Reads the cached time entries — plus, optionally, cached
// GitLab activity and a Jira lookup the agent supplied — and emits ranked
// findings. Everything here is deterministic and local: no network, no model,
// no judgement. The same entries produce the same findings twice, which is the
// only way a review is defensible when someone disagrees with it.
//
//   node scan-entries.mjs --entries <cache.json>
//   node scan-entries.mjs --entries <cache.json> --activity <gitlab.json>
//   node scan-entries.mjs --entries <cache.json> --activity <g.json> --jira <j.json>
//
// A finding is a question, never a verdict. Every one of these patterns has an
// innocent explanation — a standup really is the same 15 minutes every day, a
// week really can be logged on Friday, a designer really does leave no trace in
// GitLab. What the scanner is good at is finding the handful of person-days
// worth a manager's attention in a month nobody could read by hand. What it
// cannot do is tell you which of them are wrong, and it must never phrase
// itself as though it can.

import {
  daysBetween, emit, fail, groupBy, isWeekend, median, normalizeNote,
  parseArgs, readConfig, readJson, round, sum, ticketKeys, weekKey,
} from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const cfg = readConfig()
if (!cfg) fail('No config found. Run the harvest-review setup first.')
if (!args.entries) fail('--entries <path> is required (the cache written by fetch-entries.mjs)')

const cache = readJson(String(args.entries))
const activity = args.activity ? readJson(String(args.activity)) : null
const jira = args.jira ? readJson(String(args.jira)) : null
const entries = cache.entries || []
if (!entries.length) fail('the entries cache is empty — nothing to scan')

// --- Configuration -------------------------------------------------------

const T = {
  maxHoursPerDay: 10,
  hardMaxHoursPerDay: 14,
  maxHoursPerWeek: 50,
  repeatedNoteDays: 3,
  repeatedNoteMinHours: 3,
  fillerMinHours: 2,
  backdateDays: 7,
  bulkSessionMinutes: 30,
  bulkMinEntries: 8,
  bulkMinDays: 3,
  noTraceMinDevHours: 4,
  uniformDaysMin: 8,
  uniformDaysRatio: 0.9,
  ticketResolvedGraceDays: 3,
  maxFindings: 80,
  ...(cfg.thresholds || {}),
}
if (args['max-findings']) T.maxFindings = Number(args['max-findings'])

// A task's kind comes from its name, because that is all a timesheet carries.
// Accounts name tasks differently, so these are defaults the config overrides
// wholesale — replace the map at setup with the account's real task list.
const TASK_KINDS = cfg.taxonomy?.taskKinds || {
  absence: 'vacation|pto|holiday|sick|absence|time off|day off|parental',
  meeting: 'meeting|standup|stand-?up|sync|retro|grooming|refinement|planning|demo|1on1|1-1|workshop|ceremon',
  review: 'code review|review',
  recruiting: 'recruit|interview|hiring|screen',
  support: 'support|on-?call|oncall|incident|ops',
  qa: '\\bqa\\b|testing|test',
  admin: 'admin|management|internal|training|learning|onboarding|documentation|travel|sales|presale',
  development: 'develop|feature|implementation|coding|maintenance|engineering|delivery|bugfix|programming',
}

// What the *note* claims was done. Deliberately keyed on verbs and artefacts —
// "implemented", "!5723", "reviewed" — rather than nouns that appear in every
// note regardless.
const NOTE_KINDS = cfg.taxonomy?.noteKinds || {
  meeting: '\\b(meeting|standup|stand-?up|sync|retro|grooming|refinement|planning|demo|1on1|1:1|call|huddle|workshop|kick-?off|attended)\\b',
  review: '\\b(review(ed|ing)?|code review|approved|feedback on|commented on)\\b',
  development: '\\b(implement(ed|ing)?|develop(ed|ing)?|cod(ed|ing)|refactor(ed|ing)?|fix(ed|ing)?|bugfix|debug(ged|ging)?|migration|endpoint|component|unit tests?|deploy(ed|ment)?|release|merge request|commit(s|ted)?|branch)\\b',
  recruiting: '\\b(interview|candidate|screening|hiring)\\b',
  support: '\\b(incident|on-?call|oncall|hotfix|outage|escalation|support ticket)\\b',
  admin: '\\b(timesheet|expenses|onboarding|training|course|reading|documentation|wiki|confluence|admin)\\b',
  absence: '\\b(vacation|holiday|pto|sick|day off|time off)\\b',
}

// Which note kinds are unremarkable under which task. Anything outside this is
// a mismatch worth a question — not proof of one, since a single note routinely
// covers a morning of mixed work.
const COMPATIBLE = {
  development: ['development', 'review', 'qa', 'support', 'admin'],
  review: ['review', 'development', 'qa'],
  meeting: ['meeting', 'admin', 'recruiting', 'review'],
  recruiting: ['recruiting', 'meeting', 'admin'],
  support: ['support', 'development', 'meeting'],
  qa: ['qa', 'development', 'review'],
  admin: ['admin', 'meeting', 'development', 'review'],
  absence: ['absence'],
}

const GENERIC_NOTES = new Set([
  '', 'work', 'working', 'development', 'dev', 'coding', 'code', 'task', 'tasks',
  'misc', 'various', 'general', 'project', 'stuff', 'daily', 'ongoing', 'continue',
  'continued', 'wip', 'work on project', 'as usual', 'same as yesterday', 'na', 'n a',
])

const ticketPattern = cfg.ticketPattern
const holidays = new Set(cfg.holidays || [])
const teamByHarvestId = new Map((cfg.team || []).map((m) => [m.harvestUserId, m]))

const compiled = (map) =>
  Object.entries(map).map(([kind, re]) => {
    try {
      return { kind, re: new RegExp(re, 'gi') }
    } catch {
      return null
    }
  }).filter(Boolean)

const taskMatchers = compiled(TASK_KINDS)
const noteMatchers = compiled(NOTE_KINDS)

function taskKind(taskName) {
  const name = String(taskName || '')
  // First match wins, so the map's order is its precedence — absence before
  // meeting before development.
  for (const { kind, re } of taskMatchers) {
    re.lastIndex = 0
    if (re.test(name)) return kind
  }
  return null
}

// All kinds the note evidences, strongest first, with how many terms hit.
function noteKinds(note) {
  const text = String(note || '')
  const hits = []
  for (const { kind, re } of noteMatchers) {
    re.lastIndex = 0
    const m = text.match(re)
    if (m && m.length) hits.push({ kind, hits: m.length, terms: [...new Set(m.map((s) => s.toLowerCase()))].slice(0, 3) })
  }
  return hits.sort((a, b) => b.hits - a.hits)
}

// --- Suppressions --------------------------------------------------------
//
// Every review generates a few findings the manager has already looked at and
// resolved — a rotation that genuinely is the same note daily, a contractor who
// legitimately batches a month. Left unsuppressed they come back every run and
// train the reader to skim, which costs more than the finding was worth.

const suppressions = (cfg.suppressions || []).map((s) => {
  let re = null
  if (s.match) {
    try {
      re = new RegExp(s.match, 'i')
    } catch {
      re = null
    }
  }
  return { ...s, re }
})

function suppressed(finding) {
  return suppressions.find(
    (s) =>
      (!s.rule || s.rule === finding.rule) &&
      (!s.userId || s.userId === finding.userId) &&
      (!s.re || s.re.test(finding.summary || '') || (finding.samples || []).some((x) => s.re.test(x))),
  )
}

// --- Finding collection --------------------------------------------------

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 }
const findings = []
const suppressedFindings = []

function add(f) {
  const finding = { severity: 'medium', ...f }
  const s = suppressed(finding)
  if (s) suppressedFindings.push({ rule: finding.rule, userName: finding.userName, reason: s.reason || null })
  else findings.push(finding)
}

const userName = (id, fallback) => teamByHarvestId.get(id)?.name || fallback || String(id)
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

// --- Shape the data once -------------------------------------------------

for (const e of entries) {
  e.kind = taskKind(e.taskName)
  e.noteKinds = noteKinds(e.notes)
  e.tickets = ticketKeys(e.notes, ticketPattern)
  e.norm = normalizeNote(e.notes)
  e.words = e.norm ? e.norm.split(' ').filter(Boolean).length : 0
}

// People the GitLab cross-check could not speak about, kept apart from the
// findings themselves. "No activity found" and "we never looked" must not read
// the same, and the second one is a configuration bug rather than a signal
// about a person.
const unmapped = new Set()
const invisible = new Set()

const byUser = groupBy(entries, (e) => e.userId)
const period = { from: cache.from, to: cache.to }

// =========================================================================
// Detectors
// =========================================================================

for (const [userId, userEntries] of byUser) {
  const name = userName(userId, userEntries[0]?.userName)
  const member = teamByHarvestId.get(userId) || {}
  const base = { userId, userName: name }
  const byDay = groupBy(userEntries, (e) => e.spentAt)

  // --- 1. Note describes work the task doesn't bill for ------------------
  //
  // The stated example: an afternoon of coding logged against Meetings, or a
  // call logged as development. Only fires when the note evidences a kind that
  // is not compatible with the task *and* evidences nothing that is — a note
  // covering both is a normal mixed morning, not a miscategorisation.
  // Grouped by task and by what the notes claim, because a habit of logging
  // calls against a delivery task is one conversation however many entries it
  // spans. Twenty findings saying the same thing is a report nobody finishes.
  const mismatched = []
  for (const e of userEntries) {
    if (!e.kind || !e.noteKinds.length) continue
    const allowed = COMPATIBLE[e.kind] || [e.kind]
    if (e.noteKinds.some((k) => allowed.includes(k.kind))) continue
    mismatched.push({ e, top: e.noteKinds[0] })
  }
  for (const [, group] of groupBy(mismatched, (m) => `${m.e.taskId}|${m.top.kind}`)) {
    const { e: first, top } = group[0]
    const hours = round(sum(group.map((m) => m.e.hours)), 0.01)
    const swapped =
      (first.kind === 'meeting' && top.kind === 'development') ||
      (first.kind === 'development' && top.kind === 'meeting')
    add({
      ...base,
      rule: 'task-mismatch',
      severity: swapped && hours >= 2 ? 'high' : 'medium',
      dates: [...new Set(group.map((m) => m.e.spentAt))].sort(),
      hours,
      entryIds: group.map((m) => m.e.id),
      summary: `${hours}h across ${plural(group.length, 'entry', 'entries')} on ${first.projectName} / ${first.taskName} (a ${first.kind} task) describing ${top.kind} work`,
      evidence: {
        taskName: first.taskName,
        noteKind: top.kind,
        terms: [...new Set(group.flatMap((m) => m.top.terms))].slice(0, 5),
        samples: group.slice(0, 3).map((m) => `${m.e.spentAt} ${m.e.hours}h ${m.e.notes.slice(0, 90)}`),
      },
      tickets: [...new Set(group.flatMap((m) => m.e.tickets))],
      check: group.some((m) => m.e.tickets.length) ? 'jira' : 'ask',
    })
  }

  // --- 2. Ticket key routed to the wrong project -------------------------
  //
  // The one class of error that moves money between clients, so it outranks
  // everything else even at half an hour.
  const prefixMap = cfg.projectByTicketPrefix || {}
  const misrouted = []
  for (const e of userEntries) {
    for (const key of e.tickets) {
      const prefix = key.split('-')[0]
      const expected = prefixMap[prefix]
      if (!expected || !e.projectId || expected === e.projectId) continue
      misrouted.push({ e, key, prefix, expected })
    }
  }
  for (const [, group] of groupBy(misrouted, (m) => `${m.prefix}|${m.e.projectId}`)) {
    const { e: first, prefix, expected } = group[0]
    const keys = [...new Set(group.map((m) => m.key))]
    const hours = round(sum(group.map((m) => m.e.hours)), 0.01)
    add({
      ...base,
      rule: 'project-mismatch',
      severity: 'high',
      dates: [...new Set(group.map((m) => m.e.spentAt))].sort(),
      hours,
      entryIds: group.map((m) => m.e.id),
      summary: `${hours}h on ${prefix} ${keys.length === 1 ? 'ticket' : 'tickets'} (${keys.slice(0, 4).join(', ')}${keys.length > 4 ? `, +${keys.length - 4}` : ''}) logged to project ${first.projectName} (#${first.projectId}); ${prefix} belongs to project #${expected}`,
      evidence: { tickets: keys.slice(0, 10), projectId: first.projectId, expectedProjectId: expected, entries: group.length },
      tickets: keys,
      check: 'ask',
    })
  }

  // --- 3. The same note, day after day -----------------------------------
  //
  // The filler pattern. Recurring meetings are the obvious false positive — a
  // 15-minute standup is identical every day and entirely honest — so short
  // meeting entries are excluded rather than explained away later.
  const noteGroups = groupBy(
    userEntries.filter((e) => e.norm && e.words >= 2 && !(e.kind === 'meeting' && e.hours <= 1) && e.kind !== 'absence'),
    (e) => e.norm,
  )
  for (const [norm, group] of noteGroups) {
    const days = [...new Set(group.map((e) => e.spentAt))].sort()
    if (days.length < T.repeatedNoteDays) continue
    const hours = sum(group.map((e) => e.hours))
    if (hours < T.repeatedNoteMinHours) continue
    const distinctHours = [...new Set(group.map((e) => e.hours))]
    const identicalHours = distinctHours.length === 1
    const span = daysBetween(days[0], days[days.length - 1]) + 1
    const consecutive = span === days.length
    add({
      ...base,
      rule: 'repeated-note',
      severity: identicalHours && days.length >= T.repeatedNoteDays + 1 ? 'high' : identicalHours || days.length >= 5 ? 'medium' : 'low',
      dates: days,
      hours: round(hours, 0.01),
      entryIds: group.map((e) => e.id),
      summary: `"${group[0].notes.slice(0, 80)}" logged on ${days.length} days${identicalHours ? ` at exactly ${distinctHours[0]}h each` : ''} — ${round(hours, 0.01)}h total`,
      evidence: {
        note: group[0].notes.slice(0, 200),
        days: days.length,
        spanDays: span,
        consecutive,
        hoursEach: identicalHours ? distinctHours[0] : null,
        task: group[0].taskName,
      },
      samples: [norm],
      tickets: [...new Set(group.flatMap((e) => e.tickets))],
      check: group.some((e) => e.tickets.length) ? 'jira' : 'gitlab',
    })
  }

  // --- 4. Notes that say nothing -----------------------------------------
  //
  // Only counted above a size threshold: "email" against 15 minutes is fine,
  // "work" against six hours is not a description of anything.
  const filler = userEntries.filter(
    (e) => e.hours >= T.fillerMinHours && e.kind !== 'absence' && (GENERIC_NOTES.has(e.norm) || e.words <= 1),
  )
  if (filler.length) {
    const hours = sum(filler.map((e) => e.hours))
    add({
      ...base,
      rule: 'filler-note',
      severity: hours >= 16 ? 'medium' : 'low',
      dates: [...new Set(filler.map((e) => e.spentAt))].sort(),
      hours: round(hours, 0.01),
      entryIds: filler.map((e) => e.id),
      summary: `${plural(filler.length, 'entry', 'entries')} totalling ${round(hours, 0.01)}h whose note is empty or a single generic word`,
      evidence: { samples: [...new Set(filler.map((e) => e.notes || '(empty)'))].slice(0, 5) },
      check: 'ask',
    })
  }

  // --- 5. A month written down in one sitting ----------------------------
  //
  // created_at against spent_at, which the timesheet UI never shows and which
  // no amount of careful note-writing can disguise. Logging Friday for the week
  // is normal and common; logging four weeks on the last day of the month means
  // the hours are a reconstruction, and reconstructions are where the errors
  // live.
  const created = userEntries
    .filter((e) => e.createdAt)
    .map((e) => ({ ...e, createdMs: Date.parse(e.createdAt) }))
    .filter((e) => !Number.isNaN(e.createdMs))
    .sort((a, b) => a.createdMs - b.createdMs)

  const sessions = []
  for (const e of created) {
    const last = sessions[sessions.length - 1]
    if (last && e.createdMs - last.endMs <= T.bulkSessionMinutes * 60000) {
      last.endMs = e.createdMs
      last.entries.push(e)
    } else {
      sessions.push({ startMs: e.createdMs, endMs: e.createdMs, entries: [e] })
    }
  }
  for (const s of sessions) {
    const days = [...new Set(s.entries.map((e) => e.spentAt))].sort()
    const lag = Math.max(...s.entries.map((e) => daysBetween(e.spentAt, String(e.createdAt).slice(0, 10))))
    const bulk = s.entries.length >= T.bulkMinEntries && days.length >= T.bulkMinDays
    const late = lag >= T.backdateDays
    if (!bulk && !late) continue
    const hours = sum(s.entries.map((e) => e.hours))
    add({
      ...base,
      rule: 'bulk-backdating',
      severity: lag >= 14 || days.length >= 10 ? 'high' : 'medium',
      dates: days,
      hours: round(hours, 0.01),
      entryIds: s.entries.map((e) => e.id),
      summary: `${s.entries.length} entries covering ${days.length} days (${days[0]}–${days[days.length - 1]}, ${round(hours, 0.01)}h) all created within ${Math.max(1, Math.round((s.endMs - s.startMs) / 60000))} min on ${new Date(s.startMs).toISOString().slice(0, 10)}${late ? `, up to ${lag} days after the fact` : ''}`,
      evidence: { createdAt: new Date(s.startMs).toISOString(), entries: s.entries.length, daysCovered: days.length, maxLagDays: lag },
      check: 'ask',
    })
  }

  // --- 6. Days and weeks that don't fit in a day or a week ---------------
  for (const [date, dayEntries] of byDay) {
    const hours = sum(dayEntries.map((e) => e.hours))
    if (hours <= T.maxHoursPerDay) continue
    add({
      ...base,
      rule: 'implausible-day',
      severity: hours > T.hardMaxHoursPerDay ? 'high' : 'medium',
      date,
      hours: round(hours, 0.01),
      entryIds: dayEntries.map((e) => e.id),
      summary: `${round(hours, 0.01)}h logged on ${date} across ${plural(dayEntries.length, 'entry', 'entries')}`,
      evidence: { breakdown: dayEntries.map((e) => `${e.hours}h ${e.taskName}`).slice(0, 8) },
      check: 'ask',
    })
  }
  const byWeek = groupBy(userEntries, (e) => weekKey(e.spentAt))
  for (const [week, weekEntries] of byWeek) {
    const hours = sum(weekEntries.map((e) => e.hours))
    if (hours <= T.maxHoursPerWeek) continue
    add({
      ...base,
      rule: 'implausible-week',
      severity: 'medium',
      date: week,
      hours: round(hours, 0.01),
      entryIds: [],
      summary: `${round(hours, 0.01)}h logged in the week of ${week}`,
      evidence: { days: [...new Set(weekEntries.map((e) => e.spentAt))].length },
      check: 'ask',
    })
  }

  // --- 7. Days that are all exactly the same size ------------------------
  //
  // Texture rather than an accusation: real weeks are lumpy. A month of days
  // that all total precisely 8.00h says the number was chosen, not measured.
  // Low severity on its own; it is what makes a *second* finding on the same
  // person worth reading.
  const dayTotals = [...byDay.entries()]
    .filter(([, es]) => !es.every((e) => e.kind === 'absence'))
    .map(([date, es]) => ({ date, hours: round(sum(es.map((e) => e.hours)), 0.01) }))
  if (dayTotals.length >= T.uniformDaysMin) {
    const counts = new Map()
    for (const d of dayTotals) counts.set(d.hours, (counts.get(d.hours) || 0) + 1)
    const [topHours, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
    const ratio = topCount / dayTotals.length
    if (ratio >= T.uniformDaysRatio) {
      add({
        ...base,
        rule: 'uniform-days',
        severity: 'low',
        // No hours: nothing here is "at stake". It is a shape, and putting the
        // period's whole total on it would make the report read as though every
        // one of those hours were in question.
        hours: null,
        entryIds: [],
        periodHours: round(sum(dayTotals.map((d) => d.hours)), 0.01),
        summary: `${topCount} of ${dayTotals.length} days total exactly ${topHours}h`,
        evidence: { dayTotal: topHours, matchingDays: topCount, totalDays: dayTotals.length },
        check: 'none',
      })
    }
  }

  // --- 8. The same entry twice on the same day ---------------------------
  for (const [date, dayEntries] of byDay) {
    const dupes = groupBy(dayEntries.filter((e) => e.norm), (e) => `${e.projectId}|${e.taskId}|${e.norm}`)
    for (const [, group] of dupes) {
      if (group.length < 2) continue
      add({
        ...base,
        rule: 'duplicate-entry',
        severity: 'low',
        date,
        hours: round(sum(group.map((e) => e.hours)), 0.01),
        entryIds: group.map((e) => e.id),
        summary: `${group.length} identical entries on ${date} (${group.map((e) => `${e.hours}h`).join(' + ')}) — "${group[0].notes.slice(0, 60)}"`,
        evidence: { task: group[0].taskName, note: group[0].notes.slice(0, 160) },
        check: 'ask',
      })
    }
  }

  // --- 9. Work logged against tickets that were already finished ---------
  if (jira?.issues) {
    const issues = new Map(jira.issues.map((i) => [String(i.key).toUpperCase(), i]))
    const known = new Set(issues.keys())
    const missing = new Set((jira.missing || []).map((k) => String(k).toUpperCase()))
    // One finding per ticket, not per entry. A month of work against one
    // long-closed ticket is a single question; nineteen copies of it is a
    // report that hides everything else.
    const unknown = new Map()
    const late = new Map()
    for (const e of userEntries) {
      for (const key of e.tickets) {
        if (missing.has(key)) {
          if (!unknown.has(key)) unknown.set(key, [])
          unknown.get(key).push(e)
          continue
        }
        const issue = issues.get(key)
        if (!issue?.resolutionDate) continue
        const resolved = String(issue.resolutionDate).slice(0, 10)
        if (daysBetween(resolved, e.spentAt) <= T.ticketResolvedGraceDays) continue
        if (!late.has(key)) late.set(key, { issue, resolved, entries: [] })
        late.get(key).entries.push(e)
      }
    }
    for (const [key, es] of unknown) {
      const hours = round(sum(es.map((e) => e.hours)), 0.01)
      add({
        ...base,
        rule: 'ticket-unknown',
        severity: 'high',
        dates: [...new Set(es.map((e) => e.spentAt))].sort(),
        hours,
        entryIds: es.map((e) => e.id),
        summary: `${hours}h across ${plural(es.length, 'entry', 'entries')} logged against ${key}, which the Jira lookup did not find`,
        evidence: { ticket: key, samples: es.slice(0, 3).map((e) => `${e.spentAt} ${e.notes.slice(0, 80)}`) },
        tickets: [key],
        check: 'ask',
      })
    }
    for (const [key, { issue, resolved, entries: es }] of late) {
      const dates = [...new Set(es.map((e) => e.spentAt))].sort()
      const hours = round(sum(es.map((e) => e.hours)), 0.01)
      const maxGap = Math.max(...es.map((e) => daysBetween(resolved, e.spentAt)))
      add({
        ...base,
        rule: 'ticket-closed-before',
        severity: maxGap >= 30 ? 'high' : 'medium',
        dates,
        hours,
        entryIds: es.map((e) => e.id),
        summary: `${hours}h across ${plural(es.length, 'entry', 'entries')} (${dates[0]}${dates.length > 1 ? `–${dates[dates.length - 1]}` : ''}) logged against ${key}, resolved ${resolved} — up to ${maxGap} days earlier`,
        evidence: { ticket: key, status: issue.status, resolutionDate: resolved, maxGapDays: maxGap, entries: es.length },
        tickets: [key],
        check: 'ask',
      })
    }
  }

  // --- 10. Coding hours with no trace in GitLab --------------------------
  //
  // The most useful check and the easiest to misuse. It fires only on days
  // billed to development-shaped tasks, only above a threshold, and only for
  // people whose activity is visible at all — an unmapped or invisible account
  // produces a note about the mapping, never a finding about the person.
  if (activity?.byUser) {
    const handle = member.gitlabUsername
    if (!handle) {
      unmapped.add(name)
    } else if (!activity.byUser[handle]) {
      invisible.add(`${name} (${handle})`)
    } else {
      const days = activity.byUser[handle].days || {}
      const quiet = []
      for (const [date, dayEntries] of [...byDay.entries()].sort()) {
        if (isWeekend(date) || holidays.has(date)) continue
        if (dayEntries.some((e) => e.kind === 'absence')) continue
        const devHours = sum(dayEntries.filter((e) => e.kind === 'development' || e.kind === 'review').map((e) => e.hours))
        if (devHours < T.noTraceMinDevHours) continue
        if (days[date]) continue
        quiet.push({ date, hours: round(devHours, 0.01) })
      }
      // Consecutive quiet days are one finding, not five: a person on a week of
      // spec work should read as one conversation.
      for (const streak of streaks(quiet)) {
        const hours = round(sum(streak.map((d) => d.hours)), 0.01)
        add({
          ...base,
          rule: 'no-trace',
          severity: streak.length >= 3 || hours >= 20 ? 'high' : 'medium',
          dates: streak.map((d) => d.date),
          hours,
          entryIds: streak.flatMap((d) => (byDay.get(d.date) || []).map((e) => e.id)),
          summary: `${hours}h of development logged over ${streak.length} day${streak.length > 1 ? 's' : ''} (${streak[0].date}${streak.length > 1 ? `–${streak[streak.length - 1].date}` : ''}) with no GitLab activity from ${handle}`,
          evidence: {
            gitlabUsername: handle,
            days: streak.map((d) => `${d.date}: ${d.hours}h`),
            projectsScanned: (activity.projectsScanned || []).length,
            viaUserFeed: (activity.fallbackUsers || []).includes(handle) || null,
          },
          check: 'ask',
        })
      }
    }
  }

  // --- 11. Development entries that name no ticket -----------------------
  //
  // Only for people who normally do name one. Half the team writing notes
  // without keys is a convention, not a finding.
  const dev = userEntries.filter((e) => e.kind === 'development' && e.hours >= 2)
  if (dev.length >= 5) {
    const keyed = dev.filter((e) => e.tickets.length).length
    const bare = dev.filter((e) => !e.tickets.length)
    if (keyed / dev.length >= 0.6 && bare.length) {
      add({
        ...base,
        rule: 'ticket-missing',
        severity: 'low',
        dates: [...new Set(bare.map((e) => e.spentAt))].sort(),
        hours: round(sum(bare.map((e) => e.hours)), 0.01),
        entryIds: bare.map((e) => e.id),
        summary: `${bare.length} of ${dev.length} development entries name no ticket, against a usual ${Math.round((keyed / dev.length) * 100)}% that do`,
        evidence: { samples: bare.slice(0, 4).map((e) => `${e.spentAt} ${e.hours}h ${e.notes.slice(0, 60)}`) },
        check: 'ask',
      })
    }
  }
}

// --- 12. The same note, from two different people, on the same day -------
//
// Real when they paired, and the note usually says so. Worth surfacing because
// the alternative — one person's timesheet copied into another's — is invisible
// from inside either one.
// Meeting entries are excluded outright. Everyone in the room writes the same
// title, so the rule fires on every shared meeting in the period and finds
// nothing — the same reasoning that keeps standups out of repeated-note. What
// is left is two people claiming the same *work*, which is the rare case worth
// looking at.
const crossDay = groupBy(
  entries.filter((e) => e.norm && e.words >= 4 && e.kind !== 'meeting' && e.kind !== 'absence'),
  (e) => `${e.spentAt}|${e.norm}`,
)
for (const [key, group] of crossDay) {
  const users = [...new Set(group.map((e) => e.userId))]
  if (users.length < 2) continue
  const [date] = key.split('|')
  add({
    userId: null,
    userName: users.map((u) => userName(u)).join(' + '),
    rule: 'clone-across-people',
    severity: 'low',
    date,
    hours: round(sum(group.map((e) => e.hours)), 0.01),
    entryIds: group.map((e) => e.id),
    summary: `${users.length} people logged the identical note on ${date}: "${group[0].notes.slice(0, 70)}"`,
    evidence: { users: users.map((u) => userName(u)), hours: group.map((e) => e.hours), task: group[0].taskName },
    check: 'ask',
  })
}

// =========================================================================

function streaks(days) {
  const out = []
  let current = []
  for (const d of days) {
    if (current.length && daysBetween(current[current.length - 1].date, d.date) > 3) {
      out.push(current)
      current = []
    }
    current.push(d)
  }
  if (current.length) out.push(current)
  return out
}

// Rank: severity first, then hours at stake. A high-severity half-hour still
// outranks a low-severity week — the point of the ordering is what to look at,
// not what is biggest.
findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (b.hours || 0) - (a.hours || 0))
const shown = findings.slice(0, T.maxFindings)

// What a verification pass would need, batched: one JQL for every key, one
// GitLab sweep for the period. Emitted even when the inputs were supplied, so
// the skill can tell the difference between "checked" and "not asked".
const needJira = [...new Set(shown.filter((f) => f.check === 'jira' || f.tickets?.length).flatMap((f) => f.tickets || []))]
const perUser = [...byUser.entries()].map(([userId, es]) => {
  const days = new Set(es.map((e) => e.spentAt))
  const mine = findings.filter((f) => f.userId === userId)
  return {
    userId,
    name: userName(userId, es[0]?.userName),
    entries: es.length,
    hours: round(sum(es.map((e) => e.hours)), 0.01),
    days: days.size,
    medianDayHours: median([...groupBy(es, (e) => e.spentAt).values()].map((d) => sum(d.map((e) => e.hours)))),
    findings: mine.length,
    high: mine.filter((f) => f.severity === 'high').length,
  }
}).sort((a, b) => b.high - a.high || b.findings - a.findings)

emit({
  ok: true,
  period,
  scanned: { entries: entries.length, users: byUser.size, hours: round(sum(entries.map((e) => e.hours)), 0.01) },
  inputs: {
    activity: args.activity ? { from: activity?.from, to: activity?.to, projects: (activity?.projectsScanned || []).length } : null,
    jira: args.jira ? { issues: jira?.issues?.length || 0, missing: (jira?.missing || []).length } : null,
  },
  perUser,
  counts: findings.reduce((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] || 0) + 1 }), {}),
  byRule: [...groupBy(findings, (f) => f.rule).entries()].map(([rule, fs]) => ({ rule, count: fs.length })).sort((a, b) => b.count - a.count),
  findings: shown,
  omitted: findings.length > shown.length ? findings.length - shown.length : null,
  // Never let a cap hide that it fired: a report that silently drops findings
  // reads as a clean month.
  omittedNote: findings.length > shown.length
    ? `${findings.length - shown.length} lower-ranked findings not shown — re-run with --max-findings to see them`
    : null,
  needs: {
    jiraKeys: needJira.length ? needJira : null,
    gitlabActivity: args.activity ? null : 'run collect-gitlab-team.mjs and re-scan with --activity to check development hours against real activity',
    unmappedUsers: unmapped.size ? [...unmapped] : null,
    invisibleUsers: invisible.size ? [...invisible] : null,
  },
  suppressed: suppressedFindings.length ? suppressedFindings : null,
})
