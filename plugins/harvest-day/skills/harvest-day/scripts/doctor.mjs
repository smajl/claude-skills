#!/usr/bin/env node
// Preflight for harvest-day: is there a config, and do the local CLIs work?
// MCP servers (Harvest, Calendar, Jira, Granola, Slack) can't be probed from a
// script — the skill checks those itself by calling a cheap tool on each.
//
//   node doctor.mjs

import { existsSync } from 'node:fs'
import { configPath, findRepos, readConfig, resolveTimezone, run, emit } from './lib.mjs'

const cfg = readConfig()
const checks = []

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
  // False means the config cannot produce a valid log_time call. Collect and
  // propose anyway if you like, but do not offer to write until it's fixed.
  canWrite: Boolean(cfg) && checks.find((c) => c.name === 'config-values')?.ok === true,
  checks,
  mcpToVerify: ['harvest', 'google-calendar', 'atlassian(jira)', 'granola', 'slack'],
})
