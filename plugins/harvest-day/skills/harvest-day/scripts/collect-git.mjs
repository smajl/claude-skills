#!/usr/bin/env node
// Collect local git evidence for a date range: your commits (all branches),
// branches you checked out, and whether the tree is still dirty.
//
//   node collect-git.mjs --from 2026-07-29 --to 2026-07-29 [--repos a,b] [--config path]

import { basename } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { dayWindow, findRepos, localToday, parseArgs, prune, readConfig, resolveTimezone, run, emit, fail, ticketKeys } from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const cfg = args.config ? JSON.parse(readFileSync(args.config, 'utf8')) : readConfig()
if (!cfg) fail('No config found. Run the harvest-day setup first.')
if (!args.from) fail('--from is required (YYYY-MM-DD)')

const from = String(args.from)
const to = String(args.to || args.from)
const full = Boolean(args.full)
const tz = args.tz ? String(args.tz) : resolveTimezone(cfg)
const window = dayWindow(from, to, tz)
const authors = cfg.identity?.gitAuthors || []
if (!authors.length) fail('config.identity.gitAuthors is empty')

const pattern = cfg.ticketPattern
const roots = cfg.repos?.roots || []
const only = args.repos ? String(args.repos).split(',').map((s) => s.trim()) : cfg.repos?.include
const exclude = new Set(cfg.repos?.exclude || [])

// Resolve the repo list: an explicit include list wins, otherwise every repo
// discovered under the configured roots.
let paths = findRepos(roots, cfg.repos?.depth ?? 2)
if (Array.isArray(only) && only.length) {
  const wanted = new Set(only)
  paths = paths.filter((p) => wanted.has(basename(p)) || wanted.has(p))
  // Allow absolute paths in the include list that live outside the roots.
  for (const o of only) if (existsSync(o) && !paths.includes(o)) paths.push(o)
}
paths = paths.filter((p) => !exclude.has(basename(p)))

const SEP = String.fromCharCode(31) // matches %x1f in the git format strings below
const today = localToday(tz)

// Several checkouts of the same remote (hume-web, hume-web-2.28, hume-web-3.0)
// each report the same commits. Key logical repos by remote URL so the same
// work isn't counted two or three times.
const byRemote = new Map()

for (const path of paths) {
  const authorArgs = authors.flatMap((a) => ['--author', a])
  // Offset-bearing bounds: a bare "2026-07-30 00:00:00" would be read in the
  // machine's local timezone, which need not be the user's configured one.
  const log = run('git', [
    '-C', path, 'log', '--all', '--no-merges', ...authorArgs,
    `--since=${window.since}`, `--until=${window.until}`,
    `--pretty=format:@@@%H${SEP}%aI${SEP}%s${SEP}%D`,
    '--numstat',
  ])
  if (!log.ok) continue

  const commits = []
  let current = null
  for (const line of log.out.split('\n')) {
    if (line.startsWith('@@@')) {
      const [sha, date, subject, refs] = line.slice(3).split(SEP)
      current = {
        sha: sha.slice(0, 10),
        date,
        subject,
        refs: refs || '',
        files: 0,
        insertions: 0,
        deletions: 0,
        tickets: ticketKeys(`${subject} ${refs}`, pattern),
      }
      commits.push(current)
      continue
    }
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (m && current) {
      current.files++
      current.insertions += m[1] === '-' ? 0 : Number(m[1])
      current.deletions += m[2] === '-' ? 0 : Number(m[2])
    }
  }

  // Branch checkouts in the window — evidence of work that produced no commit.
  const reflog = run('git', [
    '-C', path, 'reflog', '--date=iso-strict',
    `--since=${window.since}`, `--until=${window.until}`,
    '--pretty=format:%gd%x1f%gs',
  ])
  const branches = new Set()
  if (reflog.ok) {
    for (const line of reflog.out.split('\n')) {
      const m = line.match(/checkout: moving from .+ to (.+)$/)
      if (m) branches.add(m[1].trim())
    }
  }
  for (const c of commits) {
    for (const ref of c.refs.split(',')) {
      const name = ref.replace(/^HEAD ->\s*/, '').trim()
      if (name && !name.startsWith('tag:')) branches.add(name)
    }
  }

  let dirty = null
  if (to >= today) {
    const status = run('git', ['-C', path, 'status', '--porcelain'])
    if (status.ok) {
      const files = status.out.split('\n').filter(Boolean)
      dirty = { files: files.length, sample: files.slice(0, 10) }
    }
  }

  const branchList = [...branches]
  if (!commits.length && !branchList.length && !dirty?.files) continue

  const remote = run('git', ['-C', path, 'remote', 'get-url', 'origin'])
  const key = remote.ok ? remote.out.trim() : path
  const entry = byRemote.get(key) || {
    name: basename(path),
    remote: remote.ok ? remote.out.trim() : null,
    paths: [],
    commits: [],
    branches: new Set(),
    dirty: null,
    _seen: new Set(),
  }
  entry.paths.push(path)
  for (const c of commits) {
    if (entry._seen.has(c.sha)) continue
    entry._seen.add(c.sha)
    entry.commits.push(c)
  }
  for (const b of branchList) entry.branches.add(b)
  if (dirty?.files) {
    entry.dirty = entry.dirty
      ? { files: entry.dirty.files + dirty.files, sample: entry.dirty.sample.concat(dirty.sample).slice(0, 10) }
      : dirty
  }
  byRemote.set(key, entry)
}

const repos = [...byRemote.values()].map((e) => {
  const branches = [...e.branches]
  return prune({
    name: e.name,
    remote: e.remote,
    // Only interesting when there's more than one — a single path is already
    // implied by the repo name.
    paths: e.paths.length > 1 ? e.paths : null,
    duplicateCheckouts: e.paths.length > 1 || null,
    commits: e.commits
      .sort((a, b) => a.date.localeCompare(b.date))
      // `refs` is raw `%D`; it has already been distilled into branches[] and
      // branchTickets[] below, so shipping it again is pure duplication.
      .map((c) => prune(full ? c : { ...c, refs: null })),
    branches,
    branchTickets: ticketKeys(branches.join(' '), pattern),
    dirty: e.dirty,
    totals: {
      commits: e.commits.length,
      insertions: e.commits.reduce((s, c) => s + c.insertions, 0),
      deletions: e.commits.reduce((s, c) => s + c.deletions, 0),
    },
  })
})

emit({ ok: true, source: 'git', from, to, window, scanned: paths.length, repos })
