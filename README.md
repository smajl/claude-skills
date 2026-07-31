# jan-marketplace

Personal Claude Code plugin marketplace for Jan Pesa. Hosts one plugin per
skill/agent/command, so each can be installed and updated independently.

## Layout

```
.claude-plugin/marketplace.json   # marketplace manifest — lists every plugin below
plugins/
  <plugin-name>/
    .claude-plugin/plugin.json    # plugin manifest
    skills/<plugin-name>/SKILL.md # (or commands/, agents/ — whatever the plugin needs)
```

## Adding a new plugin

1. Create `plugins/<name>/.claude-plugin/plugin.json`.
2. Add the skill/command/agent content under `plugins/<name>/` (e.g. `skills/<name>/SKILL.md`).
3. Add an entry for it to the `plugins` array in `.claude-plugin/marketplace.json`,
   with `"source": "./plugins/<name>"`.
4. Commit and push. Machines with this marketplace added just need
   `/plugin marketplace update jan-marketplace` to see it.

## Installing on a machine

```
/plugin marketplace add <this-repo-url>
/plugin install example-skill@jan-marketplace
```

To pick up updates later:

```
/plugin marketplace update jan-marketplace
```
