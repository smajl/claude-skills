#!/usr/bin/env node
// Read and write the shared key store at ~/.claude/.env-keys.
//
// Byte-for-byte the same file as harvest-review's copy, on purpose: the plugins
// install separately, either one may be the only one present, and both must be
// able to set the Harvest token that they share. Fix a bug here and fix it
// there.
//
//   node keys.mjs --list                  what is set, and where it came from
//   node keys.mjs --set BAMBOO_API_KEY    value is read from stdin
//   node keys.mjs --check HARVEST_TOKEN   one name, exit 0 if resolvable
//   node keys.mjs --path                  where the file is
//
// **The value only ever arrives on stdin.** Passing a secret as an argument
// puts it in shell history, in the process list while the command runs, and —
// when an agent is driving the terminal — in the conversation transcript, which
// is the one place a user cannot revoke it from. So there is no --value flag,
// and adding one would defeat the point of this file existing.
//
// The user runs the --set themselves:
//
//   PowerShell:  Read-Host -AsSecureString ... | node keys.mjs --set NAME
//   bash/zsh:    read -rs V && printf %s "$V" | node keys.mjs --set NAME
//
// Nothing here ever prints a key's value. --list prints names, sources and
// lengths, because "it is set but it is 3 characters long" is the diagnosis
// that a masked value would give away for free and a bare boolean would not.

import { emit, fail, keysPath, loadKeys, parseArgs, secret, writeKey } from './lib.mjs'

const args = parseArgs(process.argv.slice(2))

// Every key any plugin in this marketplace looks for, so that --list can report
// on the ones that are absent as well as the ones that are present. A key store
// nobody can enumerate is the problem this replaced.
const KNOWN = [
  { name: 'HARVEST_TOKEN', used: 'harvest-log, harvest-review', what: 'Harvest personal access token' },
  { name: 'HARVEST_ACCOUNT_ID', used: 'harvest-log, harvest-review', what: 'Harvest account id' },
  { name: 'BAMBOO_API_KEY', used: 'harvest-review', what: 'BambooHR API key (time off)' },
  { name: 'HARVEST_LOG_SLACK_TOKEN', used: 'harvest-log', what: 'Slack user token (huddle durations)' },
]

if (args.path) {
  emit({ ok: true, path: keysPath() })
} else if (args.check) {
  const s = secret(String(args.check))
  emit({ ok: Boolean(s.value), name: s.name, set: Boolean(s.value), source: s.source })
  if (!s.value) process.exitCode = 1
} else if (args.set) {
  const name = String(args.set)
  const value = (await readStdin()).replace(/\r?\n$/, '')
  if (!value) {
    fail(
      `no value on stdin. Pipe it in rather than passing it as an argument:\n` +
        `  bash:       read -rs V && printf %s "$V" | node keys.mjs --set ${name}\n` +
        `  PowerShell: $v = Read-Host -MaskInput; $v | node keys.mjs --set ${name}`,
    )
  }
  try {
    const r = writeKey(name, value)
    const shadowed = Boolean(process.env[name]) && process.env[name] !== value
    emit({
      ok: true,
      name,
      path: r.path,
      action: r.replaced ? 'replaced' : 'added',
      length: value.length,
      // A stale exported variable outranks the file and would keep winning
      // silently, which looks exactly like the write not having worked.
      warning: shadowed
        ? `$${name} is also set in this environment with a different value, and the environment wins. Unset it (or start a new terminal) or this file's value will not be used.`
        : null,
    })
  } catch (e) {
    fail(e.message)
  }
} else {
  const file = loadKeys({ reload: true })
  emit({
    ok: true,
    path: file.path,
    exists: file.exists,
    error: file.error,
    warnings: file.warnings.length ? file.warnings : null,
    keys: KNOWN.map(({ name, used, what }) => {
      const s = secret(name)
      return { name, what, usedBy: used, set: Boolean(s.value), source: s.source, length: s.value ? s.value.length : 0 }
    }),
    // Names in the file that no plugin here reads — usually a typo in one of
    // the names above it, which otherwise reads as "not set".
    unrecognised: Object.keys(file.keys).filter((k) => !KNOWN.some((x) => x.name === k)),
  })
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}
