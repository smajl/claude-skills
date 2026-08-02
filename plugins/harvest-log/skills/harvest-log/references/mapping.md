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

### Slack huddles

A huddle rarely says what it was about — that is its nature, and the user has
accepted it. **Default every huddle to the product project's meetings task**
and don't strain to classify it. Two things legitimately override that:

- The huddle carries a `title`, or names a ticket key in it — route on that
  like any other cluster.
- The people in `with` settle it: a huddle with a candidate is Recruiting, one
  with the whole FE channel during an incident is maintenance.

Note text is `huddle with <names>`, or `huddle with <names> — <title>` when
there is one. Three or more participants read better as
`huddle with Yusuf, Jakub +2`. Never reach into the surrounding DM to guess a
subject: that is private message content, and the note rule below is absolute.

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

## One piece of work, several sources

Most sources see different things. Two of them see the same thing, and will
double-count it unless told not to.

**git commits and GitLab pushes are the same work.** A push event is the
delivery of commits the local collector already has, with a diffstat and an
author date attached. Join them on `repos[].slug` from git against
`pushes[].project` from GitLab — both are `group/project` — and then:

- Slug matches a local repo **and git found commits for it in this window** →
  **git wins.** It has the diff volume and the real authoring dates. The push
  contributes nothing to the score; at most it confirms the work left the machine.
- Slug matches a local repo but **git found no commits in the window** → the
  commits were authored earlier and pushed today. Score the push under
  "delivering older work" above. Without this the day reads as empty in a repo
  the user demonstrably worked in, which is the failure the join was supposed to
  prevent.
- Slug has no local repo → the push is the *only* evidence, so it becomes its
  own cluster. This is the case the join exists to protect: a repo not cloned
  on this machine would otherwise vanish entirely. Score it from
  `pushes[].commits`, and say in the Why column that there's no local checkout,
  since no diff volume is available to size it properly.

The same logic applies to "untracked work grouped by repo": build those
clusters from local git, then fold in only the GitLab pushes whose slug found
no local match. Never create one cluster from the commits and a second from
the pushes that carried them.

MR review activity is *not* covered by this rule — reviewing someone else's MR
leaves no local commits, so `reviews[]` is independent evidence and is scored
on its own.

## Collapse to the shape the user logs

Clustering is deliberately fine-grained: one per ticket, per repo, per reviewed
MR, per commented page. That is how you avoid missing work. It is not how anyone
fills in a timesheet, and a proposal that mirrors the clustering hands the user
eight rows to check where they would have written one.

So after routing and before estimating, **merge every work cluster that shares a
project and task into a single row.** The ticket keys move into the note; the
individual clusters survive only as the row's Why column and as the weights that
split its hours.

`harvest.calibration.medianWorkEntriesPerDay` says how many non-meeting entries
the user actually writes on a normal day. Setup measures it. When the collapsed
proposal still carries several times that many work rows, the clustering has
split one piece of work — look for the join before presenting it.

Three exceptions, all of which are separate rows even when the task matches:

- **Meetings.** One per event, at true duration. They are already small and
  already exact, and bundling them destroys the one column that isn't estimated.
- **A cluster the user has separately corrected before**, via `learnedRoutes`.
- **A row still marked `?`.** Never merge an unrouted cluster into a routed one;
  that hides the question instead of asking it.

Merging changes only presentation, never the total. If two clusters would have
been 2.5h and 1.5h, the merged row is 4h — the sizing rules below still run per
cluster, and the merge sums them afterwards.

## Estimation

### Meetings

Exact calendar duration, in both the evidence and fill columns. A 50-minute
meeting is 50 minutes.

A Slack huddle's `durationMinutes` is measured the same way and gets the same
treatment — it is elapsed room time, not a booked slot, so if anything it is
the more honest of the two. The one huddle that is *not* exact is one flagged
`durationUnknown`: no end instant came back, so propose
`sources.slack.huddles.fallbackHuddleHours` and say in the Why column that the
figure is a default. Same for every huddle when the collector fell back to the
MCP path — there, no duration is measured at all.

**Don't count a huddle that overlaps a calendar meeting.** A scheduled call
that happened to run in Slack produces both a calendar event and a huddle, and
billing the two is billing the meeting twice. Keep the calendar event, drop the
huddle, and mention the huddle in the Why column as confirmation the meeting
actually took place.

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
| Commits pushed with none authored today | `1 × √n`, cap 3 — see "delivering older work" |
| MR opened | `1` — description, CI, cleanup |
| MR merged | `0.5` — rebase, conflicts, watching the pipeline |
| Review comments authored | `1.5 × √n × substance`, cap 5 |
| Confluence comments on a page | `0.8 × √n × substance`, cap 4 |
| Confluence page authored / edited | `2`, only when the user is the last modifier |
| Substantive Slack messages in work channels | `0.6 × √n × substance`, cap 3 |
| Jira transition or comment | `0.5` each, cap 2 — small, but rescues no-commit days |
| Branch touched, no commit | `0.5` — real work happened, it just didn't land |

`substance` is `0.5` for rubber stamps ("👍", "nit: typo"), `1` for ordinary
review, `1.5` for a threaded design argument. Judge it from the comment
excerpts the collectors return — surfacing them is the whole reason they're
there. A threaded design argument outweighs ten "👍" replies.

**Comments are cheaper than code, and the points say so.** A Confluence comment
is a few minutes of thought and typing; an MR is an afternoon. Scoring both at
`1.5 × √n` lets a busy comment thread outweigh a day of shipped work — eleven
comments on one page score more than two MRs opened, one merged and four commits
pushed, which is simply wrong. Doc review is real and frequently invisible, so it
keeps a generous coefficient and a floor, but it is capped where code work is
not.

**Slack messages score too**, and this is the only line that rescues a day spent
in support, incident triage or design discussion. Count only substantive
messages in work channels — a one-word reply, an emoji, `#gardening` and DM
banter are not work. Never quote their content into a note; they are scored, not
cited.

### Delivering older work

Attribution follows the author date, so commits written on Tuesday and pushed on
Friday score on Tuesday. That is correct, and it leaves Friday looking empty even
though Friday is when the branch was rebased, the MR written, the pipeline
watched and the review answered.

So when a repo has **pushes in the window but no commits authored in it**, score
the pushed commits at `1 × √n` — half the rate of authored commits, because the
writing was already billed and only the delivery belongs to today. This is the
one case where a push whose slug matches a local repo still scores; the general
rule below ("git wins") assumes git can see the work, and here it cannot.

**Score no commit marked `dateUnreliable`.** That flag means a squash merge:
its diff is the whole branch replayed, and every line of it was already scored
on the days it was actually written. Counting it again would bill the same work
twice, and at squash-day rates. Mention it in the row's Why column — "merged
!412" is a real event worth a few minutes — but let the score come from the
underlying commits, not from the squash.

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

Cap any single work cluster at `dayTarget − Σ meeting hours`. The cap is that
fixed bound, not "whatever is unallocated so far" — otherwise the answer
depends on which cluster you happen to size first.

**Never let the cap hide the fact that it fired.** Keep the uncapped figure,
mark the row `← capped (N.NNh)`, and if the day's *uncapped* work evidence
exceeds `dayTarget − Σ meeting hours`, say so under the table and offer to raise
the target:

```
Evidence totals 6.75h against a 2h target — the target may be wrong for this day.
Raise it to 6.75h?  [y / n / other]
```

A capped row is the only place the evidence column can disagree with the target,
and that disagreement is information: `dayTotals` are medians, and a median is
precisely the wrong thing to clip an outlier against. Silently clipping produces
a table whose two columns agree, whose rows sum to target, and which is hours
short — internally consistent and wrong, the one output shape this skill exists
to avoid.

This also restores the `← thin` check below. That flag compares fill against
evidence, so clipping evidence down to the target makes fill and evidence agree
by construction and the flag can never fire. Compare against the **uncapped**
evidence.

Same rule as everywhere else: detect, surface, ask. Don't raise the target on
your own — a genuinely over-scored cluster (a lockfile churn, a vendored
directory) looks identical at this point, and the user can tell the difference
in a second.

### Work clusters — fill estimate

`dayTarget` is chosen per day from `harvest.calibration.dayTotals` — weekday,
weekday-with-an-evening-session, or weekend — as set out in `SKILL.md` Phase 5.
It is not `targetHoursPerDay`, which is only the fallback when calibration is
missing. Using one figure for every day pads short weekend stretches into full
days and clips long ones back to eight, and both errors look plausible in the
table.

`remaining = dayTarget − Σ meeting hours`, distributed across work clusters
proportional to evidence score, rounded to 0.25, with the largest cluster
absorbing rounding drift so the day lands exactly on target.

If the Slack ad-hoc absence check (`references/collectors.md`) found a stated
absence for the day, use `dayTarget − absence hours` in place of `dayTarget`
for this whole calculation — an afternoon shortened by a
2h doctor's appointment should land the day at 6h, not be padded to 8 by
over-filling the nearest work cluster.

Three cases where that doesn't apply, all of them reachable:

- **`remaining <= 0`** — a day of nothing but meetings. Fill == evidence. The
  day is over target on meetings alone; say so and let the user trim.
- **`remaining > 0` but no work clusters at all** — meetings and nothing else.
  There is nothing to distribute across, and inventing a row to reach target
  would be inventing evidence, which this skill does not do. Fill == evidence,
  the day lands under target, and the footer states the gap plainly: "2.5h
  unaccounted for — no code, review or document evidence found." Then suggest
  where it might have gone: a source that's disabled or errored, an untracked
  repo, Slack, or simply a day that wasn't 8 hours.
- **`remaining` is large relative to the evidence** — one 1-commit cluster
  should not silently absorb 7 hours. When a cluster's fill exceeds `3 ×` its
  **uncapped** evidence estimate, cap it there, leave the day short, and flag the
  row `← thin`. A visible shortfall the user can correct beats a
  plausible-looking number they can't check. Compare against the uncapped figure:
  a row already clipped by the target cap has, by construction, a fill equal to
  its evidence, and comparing against the clipped value silently disables this
  flag on exactly the days it is needed.

In all three, the fill column is allowed to miss the target. The header shows
the real sum, never the target dressed up as one.

### Both columns

Show them side by side and let the user pick per day. Neither is authoritative —
the user's memory is. The tables exist so they can correct fast, not so they can
rubber-stamp.

## Notes

- One line, ticket key first: `HUME-5720 Select V2 - remaining replacements, coding, reviews`.
- Review entries name the MR: `review MR "HUME-8582 Replace BasicSelect in ActionInputParameterRow.vue"`.
- Bundled meetings use a `- item` list inside one note.
- A merged work row (see the collapse rule above) leads with the ticket that
  carried the most evidence and names the rest after it:
  `HUME-5720 Select V2 - remaining replacements; also HUME-8569 FormInput, review of !5723`.
  Keep it one line. If the merged row genuinely covers several unrelated
  tickets, a `- item` list is fine there too.
- Prefer the Jira summary over a raw commit subject.
- Never put a customer name, credential, or private DM content in a note.

## Safety

- Read Harvest before writing: `list_time_entries` for that date and user. One
  day fits in a page, but check `truncated` anyway — "no existing entries" is
  the answer that causes a double-log, so it's the one worth being sure about.
- A proposed row whose task and note closely match an existing entry is a
  duplicate — mark it and default to skipping.
- One `log_time` per confirmed row. On partial failure, report exactly which
  rows landed so a re-run doesn't double-log.
- Never delete or update an existing entry unless the user asks for that
  specific entry by id or by an unambiguous description.
