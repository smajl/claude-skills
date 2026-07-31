# Collectors

All collectors take an inclusive `--from` / `--to` day range and emit JSON on
stdout. Run them in parallel. A collector that fails prints
`{"ok": false, "error": …}` and must not abort the run.

## The day window

A "day" means the user's local day, but no two sources agree on how to say so:
git parses a datetime in whatever timezone the machine is in, GitLab returns
UTC instants, Confluence CQL is interpreted in UTC. Mixing those conventions
files late-evening and early-morning work on the wrong day — an error nobody
spots in a timesheet.

So the window is computed once, from `identity.timezone`, and every collector
emits it as `window`:

```json
"window": {
  "tz": "Europe/Prague", "from": "2026-07-30", "to": "2026-07-30",
  "startHour": 3,
  "since": "2026-07-30T03:00:00+02:00", "until": "2026-07-31T02:59:59+02:00",
  "utcStart": "2026-07-30T01:00:00.000Z", "utcEnd": "2026-07-31T01:00:00.000Z",
  "cqlStart": "2026-07-30 01:00", "cqlEnd": "2026-07-31 01:00",
  "spillsPastMidnight": true, "dstShift": null
}
```

Use these bounds for the MCP sources too, rather than deriving your own:
`cqlStart` / `cqlEnd` for Confluence CQL, `utcStart` / `utcEnd` for anything
that hands back ISO instants. `--tz` overrides the configured zone.

### The day does not end at midnight

Work does not stop politely at 00:00. A session that runs to half past midnight
is part of the evening it continued from, and filing it on the next calendar
date splits one stretch of work across two timesheet entries — one of which is
a day the user hadn't started yet.

So a day runs from `rules.dayStartHour` to the same hour the next morning.
At the default of `3`, day D is `[D 03:00, D+1 03:00)`:

| Worked at | Files under |
|---|---|
| Fri 09:00 | Friday |
| Fri 23:30 | Friday |
| Sat 00:30 | **Friday** |
| Sat 02:59 | **Friday** |
| Sat 03:01 | Saturday |

**This shifts the boundary; it is not an overlap.** Both ends move together, so
consecutive windows abut exactly and no instant belongs to two days. Extending
day D to 03:00 while day D+1 still began at midnight would put the small hours
in both, and bill them twice — the one error a timesheet must never make.

The cost of the shift is its mirror image: genuine early-morning work before
03:00 files under the previous day. At 3am that trade is nearly always right.
Someone who really does start at 05:00 wants `dayStartHour` lower, and `0`
restores literal midnight days.

`--day-start-hour N` overrides it per run. An out-of-range value (anything but
an integer 0–11) falls back to the default and doctor warns.

`spillsPastMidnight` is set whenever `startHour > 0`, i.e. whenever `until`
carries a later calendar date than `to`. When a proposal includes evidence from
after midnight, say so in the footer — a commit timestamped 00:40 appearing
under the previous day looks like a bug to anyone who doesn't know the rule.

`dstShift` is non-null on the two days a year the offset changes, which are
also the days that are 23 or 25 hours long. It is measured from the window's
actual length rather than by comparing its endpoints' offsets, because a
non-midnight boundary can land exactly on the transition — a 03:00 boundary in
Europe/Prague does — leaving both endpoints on the same offset while the day
between them is still 23 hours. Worth a mention in the footer if the day's
total looks odd.

## git — `collect-git.mjs`

```
node "${CLAUDE_PLUGIN_ROOT}/skills/harvest-day/scripts/collect-git.mjs" --from 2026-07-29 --to 2026-07-29
```

Per repo: `commits[]` (sha, author `date`, subject, insertions, deletions,
files, `tickets[]`, plus `rewritten` / `squashedFrom` where they apply),
`branches[]` (from refs *and* reflog checkouts, so branches worked on without a
commit still show up), `branchTickets[]`, `dirty` (only when the range includes
today), and `totals`. `--full` adds each commit's raw `%D` refs,
which are otherwise omitted — `branches[]` and `branchTickets[]` are the same
information, already deduplicated.

Empty fields are omitted rather than sent as `null` or `[]`, so a repo with no
branch activity simply has no `branches` key.

Reads `repos.include` from config, or every repo under `repos.roots` when the
include list is empty. Author matching uses every string in
`identity.gitAuthors` as an OR'd `--author` regex.

### Which day a commit belongs to

A commit carries two dates. The **author date** is stamped when the code is
first committed and survives rebase, amend and cherry-pick. The **committer
date** is reset to "now" by every one of those operations.

git's `--since` / `--until` select on the committer date. Filtering on it means
a commit written Tuesday and rebased Friday vanishes from Tuesday and reappears
on Friday — absent from the day it belongs to, double-counted on a day it
doesn't. So the collector filters on the **author date**, and `commits[].date`
is the author date: the day the code was actually written.

This also makes catch-up runs work. Reconstructing Monday on Friday, after
Monday's branch was rebased Tuesday, still finds Monday's commits under
Monday — the rewritten objects kept their authoring dates.

Two fields flag the cases where the dates disagree:

- `rewritten: true` with `committed: <iso>` — author and committer dates differ
  by more than an hour, so the commit was rebased, amended or cherry-picked
  after it was written. Attribution is still correct; this is context.
- `dateUnreliable: true` with `squashedFrom: "group/proj!412"` — a **squash
  merge**, the one rewrite that really does destroy the authoring date. The
  squashed commit is authored at squash time, and the original commits live on
  only in the (usually deleted) branch. Treat it as a duplicate of work already
  counted on earlier days, not as new work. See `mapping.md`.

`--date-basis committer` restores the old behaviour. There is little reason to
use it outside of debugging.

Interpreting the rest:

- Commit timestamps bracket the working window but are not the working window —
  people commit in bursts. Use them for ordering and for detecting a day's shape,
  not as a clock.
- `insertions + deletions` is the crudest possible effort proxy. A 2000-line
  lockfile churn is not eight hours. Discount generated files, lockfiles and
  vendored paths when you see them in the diffstat.
- Pushing today what was written yesterday is common, and handled: attribution
  follows the author date, not the push. If commit evidence still wildly
  outstrips the day's plausible hours, say so rather than inflating.

## GitLab — `collect-gitlab.mjs`

```
node "${CLAUDE_PLUGIN_ROOT}/skills/harvest-day/scripts/collect-gitlab.mjs" --from 2026-07-29 --to 2026-07-29
```

Wraps `glab api events`, rolled up into the four shapes that map onto billable
lines. Every raw event lands in exactly one of them:

| Field | What |
|---|---|
| `summary` | counts: pushes, mrsOpened, mrsMerged, approvals, comments |
| `reviews[]` | grouped by MR — title, comment count, whether approved, up to 3 comment excerpts |
| `pushes[]` | grouped by project + branch — push count, total commits, first/last timestamp |
| `mrs[]` | MR lifecycle (opened, merged, closed) — the titles that become note text |
| `other[]` | issues, milestones, anything else — one line each |

`--full` adds the raw `events[]` feed. Don't pass it during a normal run: the
rollups are lossless with respect to everything Phases 4–5 use, and the raw
feed is about four times the size of all of them together.

The API's `after` / `before` take UTC dates only, so the query is widened two
days each side and the results are then filtered on the `created_at` instant
against `window`. That widening is what keeps a 00:30-local commit — 22:30 UTC
the previous day — on the day the user actually worked.

Paging stops after 5 pages (500 events). If it stops there the output carries
`truncated: true` and a `truncatedNote` — put that in the proposal's footer,
because the evidence really is incomplete. `--max-pages N` fetches further.

`reviews[]` is the payload that justifies review time — comment excerpts tell
you whether a review was a rubber stamp or a real design argument. Size review
entries from comment count and substance, not from the MR's diff size.

## GitHub — optional

Off unless `sources.github.enabled`. Uses
`gh api "/users/<identity.githubUsername>/events"` with the same normalization.
`gh` is not installed by default; doctor reports it.

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

So never query a bare local date — `created >= "2026-07-30"` files late-evening
work on the wrong day. Pass `window.cqlStart` / `window.cqlEnd` from any
collector's output, which are already the local day's midnights expressed in
UTC with a time component:

```
# window.cqlStart/cqlEnd for Europe/Prague, local day 2026-07-30
type = comment AND creator = currentUser()
  AND created >= "2026-07-29 22:00" AND created < "2026-07-30 22:00"
```

### Recipes

| Want | CQL |
|---|---|
| Comments you wrote | `type = comment AND creator = currentUser() AND created >= "<cqlStart>" AND created < "<cqlEnd>"` |
| Pages you touched | `type = page AND contributor = currentUser() AND lastmodified >= "<cqlStart>" AND lastmodified < "<cqlEnd>"` |
| Blog posts | same as pages with `type = blogpost` |

Run the comment query always. Run the page and blogpost queries only when
`sources.confluence.includePageEdits` — they're the noisier of the two, for the
reason in the second limitation below.

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

## Slack — messages

Run this every day, not only when a day looks thin — it has caught real,
otherwise-invisible work (a long design write-up, release troubleshooting, an
onboarding conversation) even on days with strong git/calendar evidence, and it
is the only source that can catch an ad-hoc absence (see below). Search the
user's own messages for the day (`from:<@user_id>`, full day window) across
`sources.slack.channels`, or all work channels when that list is empty; a burst
of substantive messages in a support or architecture channel is real work that
leaves no other trace. Never quote private DM content into a Harvest note.

### Ad-hoc absence check

Before computing fill hours, scan the same day's messages for a stated
absence — "afk", "back in ~Nh", "doctor", "leaving early", "out for lunch
meeting", and similar. Calendar OOO/holiday events and declined meetings are
not the only way a day loses hours: a one-line "heads up, afk ~2h for a doctor's
appointment" in a dev-chat channel is common and invisible to every other
collector.

When one is found, subtract the stated duration from that day's effective
`targetHoursPerDay` before distributing fill — don't fill straight to the full
target and then footnote the absence. An unstated or vague duration ("stepping
out for a bit") is worth asking the user to confirm rather than guessing.

## Slack — huddles — `collect-slack.mjs`

```
node "${CLAUDE_PLUGIN_ROOT}/skills/harvest-day/scripts/collect-slack.mjs" --from 2026-07-29 --to 2026-07-29
```

Huddles are the meetings no other source can see. They are started ad hoc, so
they reach no calendar, produce no invite and leave no Granola note — and an
afternoon of them looks, to every other collector here, like an afternoon of
nothing. That makes them the second blind spot after Confluence, and unlike
Confluence they can swallow hours at a time.

Run this collector whenever `sources.slack.enabled` and
`sources.slack.huddles.enabled` are both on. It needs a Slack **user** token
(`xoxp-…`); `references/setup.md` covers creating one.

Output is one entry per huddle:

```json
{
  "start": "2026-07-29T11:00:00.000Z", "end": "2026-07-29T11:50:00.000Z",
  "durationMinutes": 50, "with": ["Yusuf Sait Canbaz"],
  "where": "Yusuf Sait Canbaz", "whereKind": "dm",
  "segments": 2, "permalinkHint": "D06MUQK8WBB/1785322800.000100"
}
```

| Field | What |
|---|---|
| `durationMinutes` | real elapsed time, from the room's own start and end instants |
| `with` | everyone who joined at any point, the user excluded — this is the note text |
| `where` / `whereKind` | the counterpart's name for a `dm`, `#channel` for a channel |
| `title` | present only when the huddle was given a topic; usually absent |
| `segments` | >1 when a rejoin was merged — see below |
| `durationUnknown` | the huddle had no end instant; length is not available |
| `attendanceUnverified` | no participant list came back, so attendance is assumed |

### Durations here are exact — treat them like calendar durations

`durationMinutes` is measured, not inferred. It belongs in both the evidence
and the fill column at its true value, and it is never discounted
automatically — same rule as calendar meetings in `mapping.md`. A huddle is the
one ad-hoc thing in this pipeline you don't have to estimate.

The exception is `durationUnknown`, which means Slack returned no end instant —
a huddle still running, or an older record. Propose those at
`sources.slack.huddles.fallbackHuddleHours` (0.5 by default), say in the Why
column that the length is a default rather than a measurement, and let the user
correct it.

### Rejoins are one huddle, not three

Leaving and rejoining starts a fresh room, so a single conversation routinely
records two or three huddles minutes apart. The collector merges rooms in the
same conversation separated by less than
`sources.slack.huddles.coalesceGapMinutes` (10) and reports `segments: n`.

`durationMinutes` then spans the whole merged range, gaps included, which is
usually right — a call that paused is still a call. When `segments` is high and
the span is long, that assumption is worth surfacing in the Why column.

### Attendance

A huddle in a channel that the user never joined is somebody else's meeting,
and is dropped: the check is whether their id appears in the room's participant
history. Huddles that come back with no participant list at all are kept and
flagged `attendanceUnverified` rather than being guessed at in either direction.

### What limits the sweep

There is no "list my huddles" API, and **Slack search does not index huddle
events at all** — verified: searching the exact string `"A huddle started"`
returns nothing. So the only way to find them is to read conversation history,
one call per conversation.

The collector enumerates the user's conversations and reads each one across the
whole `--from`/`--to` range in a single call, so a five-day catch-up costs the
same as a single day. Two knobs bound it:

- `maxConversations` (80) caps the sweep. Hitting the cap sets `truncated` and
  a `truncatedNote` — **put it in the footer**, because a huddle that was never
  looked for is indistinguishable from a day without huddles.
- `conversations` pins an explicit list of conversation ids and skips discovery
  entirely. For someone who huddles with the same four people, this is both
  faster and complete.

Individual conversations that can't be read land in `errors[]` and also set
`truncated`; the sweep continues.

A huddle that crosses local midnight is filed on the day it **started**, with
its full duration.

### Without a token — the degraded path

When no token resolves, the collector emits
`{"ok": false, "fallback": "mcp", …}` and exits 1. That is a specific
instruction, not a generic failure: fall back to the Slack MCP, which can still
find huddle *starts*.

- Read each candidate conversation with `slack_read_channel`, bounded by
  `window.utcStart` / `window.utcEnd`, and pick out Slackbot messages reading
  `A huddle started`.
- **Do not try to search for them.** The search tools cannot see these messages.
  `read_channel` is the only route, which means you need a conversation list —
  `sources.slack.huddles.conversations`, or the people the user is known to work
  with.
- You get a start timestamp and the conversation, and nothing else: no
  duration, no participant list beyond who the DM is with. Propose each at
  `fallbackHuddleHours` and mark the row so the user knows to correct it.
- Coalesce starts less than `coalesceGapMinutes` apart, exactly as above —
  rejoins produce several of these too.

Say in the footer that huddles came from the fallback path. The difference
between a measured 50 minutes and a defaulted 30 is precisely the sort of thing
that should not be invisible in a timesheet.
