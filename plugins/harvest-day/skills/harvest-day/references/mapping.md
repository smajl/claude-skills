# Clustering, routing and estimation

## Routing to project + task

Apply in order; first match wins:

1. **`harvest.learnedRoutes`** — user-confirmed corrections from past runs.
   These always beat heuristics.
2. **Ticket prefix** — `sources.jira.projectRouting` maps a key prefix to a
   project (`HUME-*` → HUME).
3. **Repo** — `repos.projectByRepo` maps a repo name to a project.
4. **Event/meeting heuristics** — see below.
5. **Default** — `harvest.defaultProjectId`.

Within a project, pick the task from `harvest.taskRules`, which is a list of
`{ match, taskId }` evaluated in order against the cluster's combined text
(ticket summary + commit subjects + event title).

### Meeting heuristics

- Recurring team ceremonies (standup, grooming, retro, demo, sync, architecture)
  and 1on1s with teammates → the product project's meetings task.
- Interviews, candidate screens, hiring debriefs → Engineering / Recruiting.
- Company all-hands, internal admin, ops → Engineering / Management or
  Communication.
- Conference talks, courses, deliberate reading, doc review for learning →
  the product project's Training & Learning task.

An attendee list dominated by external domains is a strong signal for
recruiting or sales rather than product work.

### Confluence doc review

Route by what the document is about, not by the fact that it's a document:

- Process, role definitions, ways of working, org policy → Training & Learning.
- A page in a product space describing a feature, spec or test plan → that
  product's feature or maintenance task.
- Runbooks, release procedures, infra docs → maintenance.

Give doc-review clusters the phrase `doc review` in the text you match against
`taskRules`, so a page title alone doesn't misroute them. Note text reads
`<Page Name> doc review and discussion`.

### When to ask instead of guess

Mark the row `?` and ask when:

- Two rules of equal specificity disagree.
- A meeting title is opaque ("Chat", "Sync", a person's name alone) and no
  Granola note clarifies it.
- The cluster would land on a project the user has not logged to in 90 days.

Asking is cheap; a wrong entry that gets approved is not.

## Estimation

### Meetings

Exact calendar duration, in both the evidence and fill columns. A 50-minute
meeting is 50 minutes.

**Never apply a discount factor**, and never infer one from history — the user
often gives a meeting less than its booked slot, but which meeting and by how
much is a judgement only they can make. Present the true duration and let them
trim it in the review table. Silently shaving meeting time would hide the one
number in the whole pipeline that is actually exact.

Where it helps, surface the reason a trim might be warranted rather than
applying it: a meeting overlapping other evidence (commits landing mid-call,
Confluence comments during a 1-to-1) is worth flagging as "possibly partial".

### Work clusters — evidence estimate

Score each cluster, then map score to hours against the user's own history for
comparable work rather than a fixed table:

| Signal | Weight |
|---|---|
| Commits | strong — but sub-linear; 12 tiny commits ≠ 12× one commit |
| Meaningful diff lines (excl. lockfiles, generated, vendored) | moderate |
| Distinct files and directories touched | moderate — breadth implies context-switching |
| MR opened / merged | small fixed increment (description, CI, cleanup) |
| Review comments authored | strong for review clusters; scale with substance |
| Jira transitions / comments | small, but rescues no-commit days |
| Confluence comments on a page | strong — scale with substance, not count; a threaded design argument outweighs ten "👍" replies |
| Confluence page authored / edited | moderate, only when the user is the last modifier |
| Branch touched, no commit | small floor — real work happened |

Floor a cluster with any evidence at 0.25h. Cap any single work cluster at the
day's remaining unallocated hours.

### Work clusters — fill estimate

`remaining = targetHoursPerDay − Σ meeting hours`, distributed across work
clusters proportional to evidence score, rounded to 0.25, with the largest
cluster absorbing rounding drift so the day lands exactly on target.

If `remaining <= 0` (a day of nothing but meetings), fill == evidence and say so.

### Both columns

Show them side by side and let the user pick per day. Neither is authoritative —
the user's memory is. The tables exist so they can correct fast, not so they can
rubber-stamp.

## Notes

- One line, ticket key first: `HUME-5720 Select V2 - remaining replacements, coding, reviews`.
- Review entries name the MR: `review MR "HUME-8582 Replace BasicSelect in ActionInputParameterRow.vue"`.
- Bundled meetings use a `- item` list inside one note.
- Prefer the Jira summary over a raw commit subject.
- Never put a customer name, credential, or private DM content in a note.

## Safety

- Read Harvest before writing: `list_time_entries` for that date and user.
- A proposed row whose task and note closely match an existing entry is a
  duplicate — mark it and default to skipping.
- One `log_time` per confirmed row. On partial failure, report exactly which
  rows landed so a re-run doesn't double-log.
- Never delete or update an existing entry unless the user asks for that
  specific entry by id or by an unambiguous description.
