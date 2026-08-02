#!/usr/bin/env node
// Collect local git evidence for a date range: your commits (all branches),
// branches you checked out, and whether the tree is still dirty.
//
//   node collect-git.mjs --from 2026-07-29 --to 2026-07-29 [--repos a,b] [--config path]
//
// Commits are attributed to the day the code was *written* — the author date.
// See the long comment above the log call for why that is the only date that
// survives contact with a real workflow.

import { basename } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { dayWindow, findRepos, localToday, parseArgs, prune, readConfig, repoSlug, resolveDayStartHour, resolveTimezone, run, emit, fail, ticketKeys, withinWindow } from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const cfg = args.config ? JSON.parse(readFileSync(args.config, 'utf8')) : readConfig()
if (!cfg) fail('No config found. Run the harvest-log setup first.')
if (!args.from) fail('--from is required (YYYY-MM-DD)')

const from = String(args.from)
const to = String(args.to || args.from)
const full = Boolean(args.full)
// 'author' = when the code was written (default). 'committer' = when the
// commit object last took its current form. Only override deliberately.
const dateBasis = args['date-basis'] === 'committer' ? 'committer' : 'author'
const tz = args.tz ? String(args.tz) : resolveTimezone(cfg)
const startHour = args['day-start-hour'] !== undefined ? Number(args['day-start-hour']) : resolveDayStartHour(cfg)
const window = dayWindow(from, to, tz, startHour)
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

const SEP = String.fromCharCode(31) // %x1f — between fields
const REC = String.fromCharCode(2)  // %x02 — start of a commit record
const EOM = String.fromCharCode(30) // %x1e — end of metadata, numstat follows
const today = localToday(tz, startHour)

// A squash merge is the one rewrite that genuinely destroys the authoring
// date: the squashed commit is authored at squash time, and the originals
// live on only in the (usually deleted) branch. Detect it so the agent can
// treat it as a duplicate of work already counted, not as new work.
const MR_REF = /See merge request\s+(\S+![0-9]+)/i
const PR_REF = /^.*\(#([0-9]+)\)$/

// Several checkouts of the same remote (hume-web, hume-web-2.28, hume-web-3.0)
// each report the same commits. Key logical repos by remote URL so the same
// work isn't counted two or three times.
const byRemote = new Map()

for (const path of paths) {
  const authorArgs = authors.flatMap((a) => ['--author', a])
  // Attribution by author date, and why the bounds look lopsided.
  //
  // git's --since/--until select on the *committer* date, which rebase, amend
  // and cherry-pick all reset to "now". Filtering on it means a commit written
  // Tuesday and rebased Friday disappears from Tuesday and resurfaces on
  // Friday — missing from the day it belongs to, and double-counted on a day
  // it doesn't. The author date survives all three rewrites, so it is the only
  // honest answer to "when was this code written".
  //
  // There is no --author-since. But a commit is always committed at or after
  // it is authored, so every commit authored in the window necessarily has a
  // committer date at or after the window start. Passing --since alone yields
  // a superset; --until must be omitted, or it would drop exactly the rebased
  // commits we are trying to rescue. The precise filter happens below.
  const bounds = dateBasis === 'author'
    ? [`--since=${window.since}`]
    : [`--since=${window.since}`, `--until=${window.until}`]

  const log = run('git', [
    '-C', path, 'log', '--all', '--no-merges', ...authorArgs, ...bounds,
    `--pretty=format:${REC}%H${SEP}%aI${SEP}%cI${SEP}%D${SEP}%s${SEP}%b${EOM}`,
    '--numstat',
  ])
  if (!log.ok) continue

  const commits = []
  // Split on the record marker rather than scanning line by line: commit
  // bodies are multi-line, and we need the body to spot squash merges.
  for (const chunk of log.out.split(REC).slice(1)) {
    const cut = chunk.indexOf(EOM)
    if (cut === -1) continue
    const [sha, authored, committed, refs, subject, body] = chunk.slice(0, cut).split(SEP)

    const commit = {
      sha: sha.slice(0, 10),
      date: dateBasis === 'author' ? authored : committed,
      subject,
      refs: refs || '',
      files: 0,
      insertions: 0,
      deletions: 0,
      tickets: ticketKeys(`${subject} ${refs}`, pattern),
    }

    // Surface the rewrite rather than hiding it: a >1h gap means this commit
    // was rebased, amended or cherry-picked after it was written.
    if (Math.abs(Date.parse(committed) - Date.parse(authored)) > 3600_000) {
      commit.committed = committed
      commit.rewritten = true
    }

    const mr = MR_REF.exec(body || '')
    const pr = PR_REF.exec(subject || '')
    if (mr || pr) {
      commit.squashedFrom = mr ? mr[1] : `#${pr[1]}`
      // The author date of a squash IS the squash time, so this is the one
      // commit whose date does not mean "when the code was written".
      commit.dateUnreliable = true
    }

    for (const line of chunk.slice(cut + 1).split('\n')) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
      if (!m) continue
      commit.files++
      commit.insertions += m[1] === '-' ? 0 : Number(m[1])
      commit.deletions += m[2] === '-' ? 0 : Number(m[2])
    }

    // The precise author-date filter the git bounds above could not express.
    if (dateBasis === 'author' && !withinWindow(authored, window)) continue
    commits.push(commit)
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
    // Join key against GitLab's path_with_namespace — see mapping.md, the
    // same push must not be counted once here and again as a GitLab event.
    slug: repoSlug(e.remote),
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

emit({ ok: true, source: 'git', from, to, window, dateBasis, scanned: paths.length, repos })
