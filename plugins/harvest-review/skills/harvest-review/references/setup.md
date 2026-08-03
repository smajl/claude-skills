# Setup

First run only. The aim is the same as harvest-log's: detect everything
detectable and ask the user to confirm rather than type. A roster typed by hand
is a roster with one wrong id in it, and one wrong id is a person who reviews as
either silent or spotless.

Write the result to `~/.claude/harvest-review/config.json` using the shape in
`../templates/config.example.json`.

## 1. Where the keys live

Every plugin in this marketplace resolves a credential the same way: the
process environment first, then a shared file at `~/.claude/.env-keys`
(`$CLAUDE_CONFIG_DIR/.env-keys`). The config never holds a value, only the
*name* of the variable — `harvest.tokenEnv`, `bamboo.apiKeyEnv` — so a config
file stays safe to copy between machines and paste into an issue.

```
node "${CLAUDE_PLUGIN_ROOT}/skills/harvest-review/scripts/keys.mjs" --list
```

That reports every key the marketplace looks for, whether it is set, and
whether it came from the environment or the file. It never prints a value.

**The user pipes the secret in; you never handle it.** There is no `--value`
flag, deliberately — an argument would land in shell history, in the process
list, and in this conversation's transcript, which is the one place the user
cannot revoke it from. Ask them to run it themselves:

```powershell
# PowerShell
$v = Read-Host -MaskInput 'token'; $v | node ".../scripts/keys.mjs" --set HARVEST_TOKEN
```

```bash
# bash / zsh — the leading space keeps it out of history too
 read -rs V && printf %s "$V" | node .../scripts/keys.mjs --set HARVEST_TOKEN
```

In Claude Code the user can run either of those directly by prefixing the line
with `!`. Values that are not secret — an account id, a Bamboo subdomain — are
fine to set for them.

Environment variables still work and still win. Say so if the user already has
them exported; there is nothing to migrate.

## 2. Harvest credentials

The review reads the team's time through the REST API rather than the MCP,
because a month of a team is thousands of entries and the MCP would put every
one of them into the conversation. That needs a personal access token.

1. <https://id.getharvest.com/developers> → **Create new personal access token**.
   Name it `harvest-review`.
2. Copy the token *and* the account id shown next to it.
3. `HARVEST_TOKEN` via the stdin route above; `HARVEST_ACCOUNT_ID` is not a
   secret, so you can set it directly.

Set `harvest.tokenEnv` / `harvest.accountIdEnv` if they prefer other names.

**`harvest-log` reads the same two keys** from the same file and prefers them
over its MCP path for the same reason. One token covers both plugins; if it is
already set, this step is done. The only difference is scope — logging your own
day works with any account, while reviewing a team needs the permission below.

**The token must belong to an account that can see other people's time** — a
manager over those people, or an administrator. A plain member token returns a
well-formed empty team, and every check downstream then reports a spotless
month. `doctor.mjs` counts the users the token can see and warns when the answer
is one; do not treat that warning as cosmetic.

## 3. Roster

```
node "${CLAUDE_PLUGIN_ROOT}/skills/harvest-review/scripts/fetch-meta.mjs"
```

That returns the account's active people, projects and task names. Then:

- **Who is being reviewed.** Ask. Default to the people the user manages, not
  the whole account — a review is something a manager does for their own team,
  and a roster wider than that is worth an explicit yes.
- **GitLab handles.** Match on email first: `glab api users?search=<email>`
  resolves most of them exactly. Confirm the matches in one list rather than one
  at a time, and leave anything ambiguous blank — an unmapped person is reported
  as unmapped, which is honest, while a wrongly mapped person is reported as
  inactive, which is not.
- **Jira account ids.** Only needed for the "what did they actually move" query.
  `lookupJiraAccountId` on the Atlassian MCP resolves them from email.

## 4. Taxonomy

`fetch-meta.mjs` prints every distinct task name in the account. Read them
against `taxonomy.taskKinds` and fix the map to match this account's vocabulary
— every mismatch here becomes a false positive on `task-mismatch` for every
entry using that task, which is the fastest way to make a first review look like
noise.

Show the user the classification you arrived at and let them correct it:

```
Meetings         → meeting      Hume Meetings, Leads Sync, ENG Meetings
Development      → development  Maintenance-Core, Feature Work, Bugfixing
Recruiting       → recruiting   Recruiting, Interviews
Absence          → absence      Vacation, Sick Day, Public Holiday
Unclassified     → ?            Hume Discovery, Client Success
```

Anything left unclassified is simply never checked by `task-mismatch`. That is a
safe default and worth saying out loud, so the user can decide whether they want
it covered.

## 5. Ticket prefixes → projects

Ask which ticket prefixes belong to which Harvest project, and map only the ones
that really are one-to-one:

```json
"projectByTicketPrefix": { "HUME": 41234567, "ENG": 41234568 }
```

An unmapped prefix is never checked, which is the right default; a wrongly
mapped one flags every legitimate cross-project reference. When in doubt, leave
it out.

## 6. GitLab scope

`gitlab.projects` (paths) or `gitlab.groups` (the sweep resolves their projects,
including subgroups). Prefer a group: a project list goes stale silently, and a
repo nobody listed is a repo whose commits do not exist as far as `no-trace` is
concerned.

Verify before trusting it:

```
node "${CLAUDE_PLUGIN_ROOT}/skills/harvest-review/scripts/collect-gitlab-team.mjs" \
  --from <a week you know was busy> --to <its end>
```

Every team member should appear in `perUser` with a plausible number of active
days. Anyone missing is either genuinely not in these repos or mapped to the
wrong handle — settle which before the first real review, not during it.

## 7. Holidays

`holidays[]` keeps public holidays out of the `no-trace` check. A day nobody
worked is a day with no GitLab activity, and without the list every national
holiday produces a finding against everyone who logged it.

## 8. Write, then say what is not covered

Confirm the config path in one line, then name what the setup left uncovered —
unmapped people, unclassified tasks, prefixes not mapped. Those are the parts of
the first review that will silently pass, and the user should hear about them
before the report rather than in it.
