#!/usr/bin/env node
// Setup helper: find git repos under the given roots and report which ones the
// user has actually committed to recently, so the wizard can pre-tick them.
//
//   node scan-repos.mjs --roots "C:/dev" --authors "me@example.com,Me" [--days 90] [--depth 2]

import { basename } from 'node:path'
import { findRepos, parseArgs, run, emit, fail } from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
if (!args.roots) fail('--roots is required (comma-separated)')

const roots = String(args.roots).split(',').map((s) => s.trim()).filter(Boolean)
const authors = String(args.authors || '').split(',').map((s) => s.trim()).filter(Boolean)
const days = Number(args.days || 90)
const depth = Number(args.depth || 2)

const repos = findRepos(roots, depth).map((path) => {
  const remote = run('git', ['-C', path, 'remote', 'get-url', 'origin'])
  const authorArgs = authors.flatMap((a) => ['--author', a])
  const log = run('git', [
    '-C', path, 'log', '--all', '--no-merges',
    `--since=${days} days ago`, ...authorArgs,
    '--pretty=format:%aI',
  ])
  const dates = log.ok ? log.out.split('\n').filter(Boolean) : []
  return {
    path,
    name: basename(path),
    remote: remote.ok ? remote.out.trim() : null,
    host: remote.ok ? hostOf(remote.out.trim()) : null,
    myCommits: dates.length,
    lastCommit: dates[0] || null,
  }
})

function hostOf(url) {
  const m = url.match(/@([^:/]+)[:/]/) || url.match(/^https?:\/\/([^/]+)\//)
  return m ? m[1] : null
}

repos.sort((a, b) => b.myCommits - a.myCommits)

// Multiple checkouts of one remote (a repo plus its version branches) would
// otherwise be suggested — and later counted — several times over.
const seenRemote = new Map()
for (const r of repos) {
  const key = r.remote || r.path
  if (seenRemote.has(key)) {
    r.duplicateOf = seenRemote.get(key)
  } else {
    seenRemote.set(key, r.name)
  }
}

emit({
  ok: true,
  roots,
  windowDays: days,
  suggested: repos.filter((r) => r.myCommits > 0 && !r.duplicateOf).map((r) => r.name),
  duplicateCheckouts: repos.filter((r) => r.duplicateOf).map((r) => ({ name: r.name, sameRemoteAs: r.duplicateOf })),
  repos,
})
