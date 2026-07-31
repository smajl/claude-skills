<div align="center">

```
                         _  _
     ___ _ __ ___   __ _(_) |
    / __| '_ ` _ \ / _` | | |
                 \__ \ | | | | | (_| | | |      ( ^_^ )
    |___/_| |_| |_|\__,_| |_|
         m a r k e t p l a c e
```

**Jan Pesa's personal Claude Code plugin marketplace**

One plugin per skill, agent or command — each installed and updated on its own.

</div>

---

## 📦 Plugins

### `harvest-day` — fill your timesheet from what you actually did

Reconstructs a workday from every trace it left, proposes Harvest time entries,
and logs them **only after you confirm**.

```
   sources │  git · gitlab · jira · confluence · calendar · granola · slack
           │
   cluster │  group the evidence by ticket, meeting, MR or wiki page
           │
     route │  map each cluster to a Harvest project and task
           │
  estimate │  two hour columns — measured, and filled to target
           │
    review │  you edit the table; nothing is logged before this
           │
   harvest │  log the rows you confirmed
```

| | |
|---|---|
| 🚀 Run | `/harvest` · `/harvest yesterday` · `/harvest 2026-07-27..2026-07-31` |
| ⚙️ Config | `~/.claude/harvest-day/config.json` — written by the first-run wizard |
| 🔌 Needs | Harvest MCP · `glab` · Google Calendar, Atlassian, Granola & Slack connectors |
| 🩺 Check | `node .../scripts/doctor.mjs` reports what's wired and what isn't |

Bare `/harvest` finds the days in the last two weeks that are empty or under
target and offers to fill them. Every source is optional — a missing one
degrades to a warning, never a blocked run. Nothing reaches Harvest unreviewed.

---

## 🗂 Layout

```
.claude-plugin/marketplace.json     # marketplace manifest — lists every plugin
plugins/
  <plugin-name>/
    .claude-plugin/plugin.json      # plugin manifest
    skills/<plugin-name>/SKILL.md   # (or commands/, agents/ — whatever it needs)
```

## ➕ Adding a new plugin

1. Create `plugins/<name>/.claude-plugin/plugin.json`.
2. Add the content under `plugins/<name>/` (e.g. `skills/<name>/SKILL.md`).
3. Add an entry to the `plugins` array in `.claude-plugin/marketplace.json`
   with `"source": "./plugins/<name>"`.
4. Commit and push — other machines just need a marketplace update to see it.

## 💻 Installing on a machine

```
/plugin marketplace add <this-repo-url>
/plugin install harvest-day@smajl-marketplace
```

Pick up updates later:

```
/plugin marketplace update smajl-marketplace
```
