# Collectors

All collectors take an inclusive `--from` / `--to` day range and emit JSON on
stdout. Run them in parallel. A collector that fails prints
`{"ok": false, "error": …}` and must not abort the run.

## git — `collect-git.mjs`

```
node "${CLAUDE_PLUGIN_ROOT}/skills/harvest-day/scripts/collect-git.mjs" --from 2026-07-29 --to 2026-07-29
```

Per repo: `commits[]` (sha, ISO date, subject, insertions, deletions, files,
`tickets[]`), `branches[]` (from refs *and* reflog checkouts, so branches worked
on without a commit still show up), `branchTickets[]`, `dirty` (only when the
range includes today), and `totals`.

Reads `repos.include` from config, or every repo under `repos.roots` when the
include list is empty. Author matching uses every string in
`identity.gitAuthors` as an OR'd `--author` regex.

Interpreting it:

- Commit timestamps bracket the working window but are not the working window —
  people commit in bursts. Use them for ordering and for detecting a day's shape,
  not as a clock.
- `insertions + deletions` is the crudest possible effort proxy. A 2000-line
  lockfile churn is not eight hours. Discount generated files, lockfiles and
  vendored paths when you see them in the diffstat.
- Commits pushed today for work done yesterday are common. If commit evidence
  wildly outstrips the day's plausible hours, say so rather than inflating.

## GitLab — `collect-gitlab.mjs`

```
node "${CLAUDE_PLUGIN_ROOT}/skills/harvest-day/scripts/collect-gitlab.mjs" --from 2026-07-29 --to 2026-07-29
```

Wraps `glab api events`. Returns `summary` (pushes, mrsOpened, mrsMerged,
approvals, comments), `reviews[]` grouped by MR (title, comment count, whether
approved, up to 3 comment excerpts), and the normalized `events[]`.

`reviews[]` is the payload that justifies review time — comment excerpts tell
you whether a review was a rubber stamp or a real design argument. Size review
entries from comment count and substance, not from the MR's diff size.

## GitHub — optional

Off unless `sources.github.enabled`. Uses `gh api "/users/<user>/events"` with
the same normalization. `gh` is not installed by default; doctor reports it.

## Calendar — Google Calendar MCP

`list_events` for the day across `sources.calendar.calendars`, with
`orderBy: startTime` and the config timezone. Exclude: declined events, all-day
events, and events whose title matches `rules.ignoreEventPatterns`.

The user's own RSVP is the attendee entry with `self: true` — read its
`responseStatus`, not the event's. `needsAction` is not the same as declined;
recurring team meetings often sit at `needsAction` and were still attended, so
treat only `declined` as a skip and flag `needsAction` events as uncertain.

`start`/`end` carry per-event `timeZone` fields that can differ from the
calendar's (an organizer in another country). Compute durations from the
offset-bearing `dateTime` values, never from the wall-clock string.

Also check `sources.calendar.holidayCalendars` for the day — a company holiday
or PTO means propose nothing and say why.

Calendar durations are the only *exact* numbers in the whole pipeline — use them
as-is. Overlapping accepted meetings mean the user was in one of them: flag the
overlap and ask rather than double-counting.

Attendee lists are useful for note text ("Yusuf / Jan 1on1") and for routing —
an external-domain attendee list often means recruiting or sales, not HUME.

## Jira — Atlassian MCP

Two uses:

1. **Titles** — for each ticket key found anywhere, `getJiraIssue` gives a
   summary that makes a far better Harvest note than a commit subject.
2. **Activity** — `searchJiraIssuesUsingJql` with
   `assignee = currentUser() AND updated >= "<day>" AND updated < "<day+1>"`
   finds tickets that moved without producing a commit (triage, grooming,
   writing acceptance criteria).

Jira is read-only here. Never transition anything.

## Confluence — Atlassian MCP

Document review is real, billable, and leaves **no trace in git, GitLab, Jira or
the calendar**. It is the single biggest blind spot in every other source, so
always run this collector.

Use `searchConfluenceUsingCql` with `sources.jira.cloudId`.

### Timestamps are UTC — this is the important part

CQL `created` / `lastmodified` bounds are interpreted in **UTC**, not the user's
timezone. Verified: comments made 15:44 and 15:52 CEST match a
`created >= "2026-07-30 13:00"` bound.

So never query a bare local date. Convert the local day's midnight boundaries to
UTC and pass them with a time component:

```
# Europe/Prague (UTC+2 in summer), local day 2026-07-30
type = comment AND creator = currentUser()
  AND created >= "2026-07-29 22:00" AND created < "2026-07-30 22:00"
```

A bare `created >= "2026-07-30"` files late-evening work on the wrong day.

### Recipes

| Want | CQL |
|---|---|
| Comments you wrote | `type = comment AND creator = currentUser() AND created >= "<utcStart>" AND created < "<utcEnd>"` |
| Pages you touched | `type = page AND contributor = currentUser() AND lastmodified >= "<utcStart>" AND lastmodified < "<utcEnd>"` |
| Blog posts | same as pages with `type = blogpost` |

Add `order by created desc` and `limit: 50`.

### Reading the results

- `title` is `Re: <Page Name>` for comments — strip the `Re: ` to name the
  document in the Harvest note.
- `summary` is the comment text. Use it: substantive design argument is worth
  more time than "👍". This is the best signal available for sizing doc review.
- Comments cluster hard by page. Group every comment on one page into a single
  "review <Page Name>" entry.
- Personal spaces (`~<accountid>`, `name` shows a person) are normal — drafts
  live there. Don't filter them out.

### Two limitations to respect

- **No usable timestamp.** The API returns `lastModified` as a rendered string
  ("yesterday at 3:52 PM", or "Jul 28, 2026" for older items) and ignores
  `expand`. For today/yesterday you can read the clock time off it; for older
  days you only get the count. If you need a span, issue two or three extra
  queries with narrower UTC hour bounds and bisect — don't parse the string.
- **`contributor = currentUser()` means "ever contributed"**, not "edited that
  day". It returns pages modified in the window that the user touched at some
  point, and the result's `author` is the *last* modifier — often someone else.
  Treat a page hit as evidence only when `author` is the user, and otherwise
  mention it as weak context rather than proposing an entry.

## Granola — meeting notes

Search notes for the day. Granola supplies *substance*, never duration: use it
to turn "Front-End Architecture" into "Front-End Architecture — agreed on Select
v2 rollout plan". If a Granola note exists for a meeting that isn't on the
calendar, propose it as an entry and say where it came from.

## Slack

Use only when a day is otherwise thin, or when the user asks. Search their own
messages in work channels for the day; a burst of substantive messages in a
support or architecture channel is real work that leaves no other trace. Never
quote private DM content into a Harvest note.
