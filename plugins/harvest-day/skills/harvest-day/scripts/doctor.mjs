#!/usr/bin/env node
// Preflight for harvest-day: is there a config, and do the local CLIs work?
// MCP servers (Harvest, Calendar, Jira, Granola, Slack) can't be probed from a
// script — the skill checks those itself by calling a cheap tool on each.
//
//   node doctor.mjs

import { existsSync } from 'node:fs'
import { configPath, findRepos, readConfig, run, emit } from './lib.mjs'

const cfg = readConfig()
const checks = []

checks.push({
  name: 'config',
  ok: Boolean(cfg),
  detail: cfg ? configPath() : `missing at ${configPath()} — run setup`,
})

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
  checks,
  mcpToVerify: ['harvest', 'google-calendar', 'atlassian(jira)', 'granola', 'slack'],
})
