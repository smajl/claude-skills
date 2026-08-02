#!/usr/bin/env node
// Pull the account's people, projects and tasks — the vocabulary a review is
// written in. Used by setup to build the roster and the project/task taxonomy,
// and by the scanner to name ids.
//
//   node fetch-meta.mjs                 # summary to stdout, full data to cache
//   node fetch-meta.mjs --full          # print everything (setup only)
//
// Runs before any config exists, so it accepts credentials from the environment
// without one.

import {
  fail, finish, harvestCredentials, harvestPaged, parseArgs, readConfig, writeCache,
} from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const cfg = readConfig() // may be null on a first run — that is the point
const creds = harvestCredentials(cfg)
if (!creds.token || !creds.accountId) {
  fail(
    `Harvest credentials missing — set $${creds.tokenEnv} and $${creds.accountEnv}. ` +
      'Create a personal access token at https://id.getharvest.com/developers.',
  )
}

await main()

async function main() {
const [users, projects, assignments] = await Promise.all([
  harvestPaged('/users?is_active=true&per_page=100', creds, 'users'),
  harvestPaged('/projects?is_active=true&per_page=100', creds, 'projects'),
  // The task list that matters is the one attached to live projects; the global
  // /tasks endpoint also returns tasks nobody can log against any more.
  harvestPaged('/users/me/project_assignments?per_page=100', creds, 'project_assignments'),
])

if (!users.ok) return finish({ ok: false, error: `Harvest /users failed: ${users.error}` }, 1)

const people = users.items.map((u) => ({
  id: u.id,
  name: [u.first_name, u.last_name].filter(Boolean).join(' '),
  email: u.email,
  roles: u.roles || [],
  isActive: u.is_active,
  // access_roles distinguishes an administrator or manager from a member;
  // a manager reviewing their reports needs to know which of these people the
  // token can actually see time for.
  accessRoles: u.access_roles || [],
}))

const projectList = (projects.items || []).map((p) => ({
  id: p.id,
  name: p.name,
  code: p.code || null,
  client: p.client?.name || null,
  isBillable: p.is_billable,
}))

const tasksByProject = {}
for (const a of assignments.items || []) {
  if (!a.project?.id) continue
  tasksByProject[a.project.id] = (a.task_assignments || []).map((t) => ({ id: t.task?.id, name: t.task?.name }))
}

const cache = writeCache('meta.json', { fetchedAt: new Date().toISOString(), people, projects: projectList, tasksByProject })

// Distinct task names across the account are what the taxonomy is built from,
// and there are rarely more than a couple of dozen. Those are worth printing;
// the per-project assignment matrix is not.
const taskNames = [...new Set(Object.values(tasksByProject).flat().map((t) => t.name).filter(Boolean))].sort()

return finish({
  ok: true,
  cache,
  counts: { people: people.length, projects: projectList.length, taskNames: taskNames.length },
  people: args.full ? people : people.map((p) => ({ id: p.id, name: p.name, email: p.email })),
  projects: projectList,
  taskNames,
  tasksByProject: args.full ? tasksByProject : undefined,
  projectsError: projects.ok ? null : projects.error,
  assignmentsError: assignments.ok ? null : assignments.error,
})
}
