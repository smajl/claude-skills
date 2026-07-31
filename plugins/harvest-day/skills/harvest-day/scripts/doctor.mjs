#!/usr/bin/env node
// Preflight for harvest-day: is there a config, and do the local CLIs work?
// MCP servers (Harvest, Calendar, Jira, Granola, Slack) can't be probed from a
// script — the skill checks those itself by calling a cheap tool on each.
//
//   node doctor.mjs

import { existsSync } from 'node:fs'
import { configPath, findRepos, localToday, readConfig, resolveTimezone, run, emit } from './lib.mjs'

// Bump whenever templates/config.example.json gains or drops a field. A config
// written against an older schema is missing whatever was added since, and the
// only symptom would otherwise be quietly worse output.
const SCHEMA_VERSION = 2

const cfg = readConfig()
const checks = []
// Two tiers, deliberately. `problems` mean the config cannot produce a valid
// log_time call and block the write. `warnings` mean the run still works but
// produces worse answers — a missing calibration, an unset note style. Those
// used to degrade in silence, which is the worse failure: nobody investigates
// output that looks fine.
const warnings = []
const warn = (m) => warnings.push(m)

checks.push({
  name: 'config',
  ok: Boolean(cfg),
  detail: cfg ? configPath() : `missing at ${configPath()} — run setup`,
})

// The template ships id placeholders of 0, and Harvest's log_time requires
// project_id and task_id >= 1. Without this check a half-finished setup sails
// through preflight, collection and the user's review, and only blows up on
// the write — after the run is unrepeatable and the user has already said yes.
if (cfg) {
  const problems = []
  const id = (v) => Number.isInteger(v) && v >= 1

  if (!(cfg.identity?.gitAuthors?.length > 0)) problems.push('identity.gitAuthors is empty')
  if (!id(cfg.identity?.harvestUserId)) problems.push('identity.harvestUserId is unset')

  const tz = resolveTimezone(cfg)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
  } catch {
    problems.push(`identity.timezone "${tz}" is not a valid IANA zone`)
  }

  if (!id(cfg.harvest?.defaultProjectId)) problems.push('harvest.defaultProjectId is unset')

  // `match` is a case-insensitive regex in both rule lists. An unparseable one
  // silently routes nothing, which looks exactly like a rule that never fires.
  const badRegex = (m) => {
    if (typeof m !== 'string' || !m) return true
    try {
      new RegExp(m, 'i')
      return false
    } catch {
      return true
    }
  }

  const rules = cfg.harvest?.taskRules || []
  if (!rules.length) problems.push('harvest.taskRules is empty')
  rules.forEach((r, i) => {
    const label = r.taskName || r.match
    if (!id(r.taskId)) problems.push(`harvest.taskRules[${i}] (${label}) has no task id`)
    if ('projectId' in r && !id(r.projectId)) problems.push(`harvest.taskRules[${i}] (${label}) has an invalid project id`)
    if (badRegex(r.match)) problems.push(`harvest.taskRules[${i}] (${label}) has an invalid match regex`)
  })
  if (rules.length && !rules.some((r) => r.match === '.*')) {
    problems.push('harvest.taskRules has no catch-all ".*" rule — some clusters will not route')
  }

  ;(cfg.harvest?.learnedRoutes || []).forEach((r, i) => {
    if (!id(r.projectId) || !id(r.taskId)) problems.push(`harvest.learnedRoutes[${i}] (${r.match}) has an invalid id`)
    if (badRegex(r.match)) problems.push(`harvest.learnedRoutes[${i}] has an invalid match regex`)
  })

  for (const src of ['jira', 'confluence']) {
    if (cfg.sources?.[src]?.enabled && !cfg.sources[src].cloudId) {
      problems.push(`sources.${src}.enabled but cloudId is empty`)
    }
  }

  checks.push({
    name: 'config-values',
    ok: problems.length === 0,
    detail: problems.length ? problems.join('; ') : `${tz}, ids resolved`,
    problems,
  })

  // --- Quality warnings: the run works, the answers are just worse ---------

  const version = Number(cfg.version || 0)
  if (version < SCHEMA_VERSION) {
    warn(`config is schema v${version || '?'}, current is v${SCHEMA_VERSION} — it predates fields added since, so anything new falls back to defaults. Re-run setup to fill them in.`)
  }

  const cal = cfg.harvest?.calibration
  if (!cal) {
    warn('harvest.calibration is missing — hour estimates use the shipped defaults with no history to check them against. Re-run setup to compute it.')
  } else {
    if (!(cal.hoursPerScore > 0)) {
      warn('harvest.calibration.hoursPerScore is unset — scoring falls back to the shipped 0.28 h/point.')
    }
    if (!Object.keys(cal.medianHoursByTask || {}).length) {
      warn('harvest.calibration.medianHoursByTask is empty — estimates have no historical bound, so nothing catches an over-scored cluster. Re-run setup to compute it from 90 days of entries.')
    } else if (cal.computedFrom) {
      const age = Math.round((Date.parse(localToday(tz)) - Date.parse(cal.computedFrom)) / 86400000)
      if (age > 180) warn(`harvest.calibration was computed ${age} days ago — recompute it if the work has changed shape since.`)
    }
  }

  if (!(cfg.harvest?.targetHoursPerDay > 0)) {
    warn('harvest.targetHoursPerDay is unset — the fill column has no target to fill to.')
  }
  if (!cfg.harvest?.noteStyle) {
    warn("harvest.noteStyle is unset — notes won't match the phrasing of existing entries.")
  }
  if (cfg.sources?.gitlab?.enabled !== false && !cfg.identity?.gitlabUsername) {
    warn('identity.gitlabUsername is unset — GitLab events can still be read, but nothing verifies they belong to the right account.')
  }
  if (cfg.sources?.github?.enabled && !cfg.identity?.githubUsername) {
    warn('sources.github is enabled but identity.githubUsername is unset — the GitHub collector cannot run.')
  }
  if (cfg.sources?.jira?.enabled && !Object.keys(cfg.sources.jira.projectRouting || {}).length) {
    warn('sources.jira.projectRouting is empty — every ticket routes to the default project regardless of its key.')
  }
}

const git = run('git', ['--version'])
checks.push({ name: 'git', ok: git.ok, detail: git.ok ? git.out.trim() : git.error })

const glabWanted = cfg?.sources?.gitlab?.enabled !== false
if (glabWanted) {
  const v = run('glab', ['--version'])
  if (!v.ok) {
    checks.push({ name: 'glab', ok: false, detail: 'not installed — see https://gitlab.com/gitlab-org/cli' })
  } else {
    const auth = run('glab', ['auth', 'status'])
    // glab writes its status banner to stderr even on success.
    const text = `${auth.out || ''}\n${auth.err || ''}\n${auth.error || ''}`
    checks.push({
      name: 'glab',
      ok: /Logged in/i.test(text),
      detail: /Logged in/i.test(text) ? text.split('\n').find((l) => /Logged in/i.test(l)).trim() : 'run `glab auth login`',
    })
  }
}

if (cfg?.sources?.github?.enabled) {
  const v = run('gh', ['auth', 'status'])
  checks.push({ name: 'gh', ok: v.ok, detail: v.ok ? 'authenticated' : 'not installed or not authenticated' })
}

if (cfg) {
  const roots = cfg.repos?.roots || []
  const missing = roots.filter((r) => !existsSync(r))
  const found = findRepos(roots, cfg.repos?.depth ?? 2)
  checks.push({
    name: 'repos',
    ok: missing.length === 0 && found.length > 0,
    detail: missing.length
      ? `missing roots: ${missing.join(', ')}`
      : `${found.length} git repos under ${roots.join(', ')}`,
  })
}

emit({
  ok: checks.every((c) => c.ok),
  configPath: configPath(),
  hasConfig: Boolean(cfg),
  schemaVersion: SCHEMA_VERSION,
  configVersion: cfg ? Number(cfg.version || 0) : null,
  // True when the run will work but produce worse answers than it should.
  // Report every warning to the user — that is the whole point of the field.
  degraded: warnings.length > 0,
  warnings,
  // False means the config cannot produce a valid log_time call. Collect and
  // propose anyway if you like, but do not offer to write until it's fixed.
  canWrite: Boolean(cfg) && checks.find((c) => c.name === 'config-values')?.ok === true,
  checks,
  mcpToVerify: ['harvest', 'google-calendar', 'atlassian(jira)', 'granola', 'slack'],
})
