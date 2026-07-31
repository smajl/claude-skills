# Clustering, routing and estimation

## Routing to project + task

Every rule that matches text does so the same way: **`match` is a
case-insensitive regular expression**, tested against the cluster's combined
text (ticket summary + commit subjects + event title + note text). This holds
for both `harvest.taskRules` and `harvest.learnedRoutes` — they are not two
different matching schemes.

**Project** — apply in order; first match wins:

1. **`harvest.learnedRoutes`** — user-confirmed corrections from past runs.
   Each carries both a `projectId` and a `taskId`, so a match here settles the
   whole route and the task step below is skipped. These always beat heuristics.
2. **A `harvest.taskRules` entry that carries a `projectId`** — a rule may
   override the project as well as the task, for work that always lives
   somewhere other than the default (interviews under Engineering, say). Only
   entries that actually have a `projectId` participate here; most don't.
3. **Ticket prefix** — `sources.jira.projectRouting` maps a key prefix to a
   project (`HUME-*` → HUME).
4. **Repo** — `repos.projectByRepo` maps a repo name to a project.
5. **Event/meeting heuristics** — see below.
6. **Default** — `harvest.defaultProjectId`.

**Task** — unless step 1 already settled it, walk `harvest.taskRules` in order
and take the `taskId` of the first entry whose `match` hits. Keep a `".*"`
catch-all last so every cluster lands somewhere; doctor warns when it's
missing.

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

Three steps: score the cluster, convert the score to hours, bound the result
against what the user actually logs.

#### 1. Score

| Signal | Points |
|---|---|
| Commits | `2 × √n` — sub-linear on purpose; 12 tiny commits ≠ 12× one commit |
| Meaningful diff lines (excl. lockfiles, generated, vendored) | `lines ÷ 150`, cap 6 |
| Distinct directories touched | `0.4` each, cap 3 — breadth implies context-switching |
| MR opened | `1` — description, CI, cleanup |
| MR merged | `0.5` — rebase, conflicts, watching the pipeline |
| Review comments authored | `1.5 × √n × substance` |
| Confluence comments on a page | `1.5 × √n × substance` |
| Confluence page authored / edited | `2`, only when the user is the last modifier |
| Jira transition or comment | `0.5` each, cap 2 — small, but rescues no-commit days |
| Branch touched, no commit | `0.5` — real work happened, it just didn't land |

`substance` is `0.5` for rubber stamps ("👍", "nit: typo"), `1` for ordinary
review, `1.5` for a threaded design argument. Judge it from the comment
excerpts the collectors return — surfacing them is the whole reason they're
there. A threaded design argument outweighs ten "👍" replies.

#### 2. Score → hours

`hours = score × harvest.calibration.hoursPerScore`, rounded to 0.25, floored
at 0.25 for any cluster with evidence at all. The shipped default of `0.28`
h/point gives:

| Score | 1 | 2 | 4 | 7 | 11 | 18 |
|---|---|---|---|---|---|---|
| Hours | 0.25 | 0.5 | 1.25 | 2 | 3 | 5 |

**These numbers are a chosen starting point, not a measurement.** Their job is
to make two similar days produce similar estimates, and to give the user
something concrete to correct rather than a number invented fresh each run.
Phase 8 tightens `hoursPerScore` from those corrections — after a few runs it
is the user's number, and it should be trusted over this table.

#### 3. Bound against history

`harvest.calibration.medianHoursByTask` maps task id → the median hours the
user logs per entry on that task, computed at setup from 90 days of their own
entries. It is the only measured quantity in this section, so use it as a
bound rather than as the estimate:

- Above `2 ×` the median for that task → probably over-scored. Keep the number
  but append `← large` to the row so it draws the eye.
- Below `0.25 ×` the median → probably a fragment of something bigger; check
  whether it should merge into a neighbouring cluster.
- No entry for that task id → no bound available, estimate as-is.

Cap any single work cluster at `targetHoursPerDay − Σ meeting hours`. The cap
is that fixed bound, not "whatever is unallocated so far" — otherwise the
answer depends on which cluster you happen to size first.

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
