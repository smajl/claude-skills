#!/usr/bin/env node
// Collect Slack huddles for a date range via the Slack Web API.
//
// Huddles are the one meeting kind that never reaches the calendar: they are
// started ad hoc, they leave no invite, and they can eat an afternoon. Slack
// records them as a message carrying a `room` object with the real start
// instant, end instant and participant list — which is everything a Harvest
// meeting row needs.
//
//   node collect-slack.mjs --from 2026-07-29 --to 2026-07-29
//   node collect-slack.mjs --probe          # dump raw room payloads to verify
//
// Needs a Slack **user** token (xoxp-…) with, at minimum:
//   users:read
//   channels:history  groups:history  im:history  mpim:history
//   channels:read     groups:read     im:read     mpim:read
// A bot token will not do: it only sees huddles in conversations the bot was
// invited to, which is none of the user's DMs.
//
// Resolution order for the token: --token, $HARVEST_LOG_SLACK_TOKEN, the env
// var named by sources.slack.tokenEnv, then sources.slack.token. Prefer one of
// the env forms — a token in config.json is a token in a file that gets copied
// around.
//
// Without a token this exits with `fallback: "mcp"`, which tells the skill to
// fall back to reading huddle *start* events through the Slack MCP. See
// references/collectors.md — that path knows when a huddle began and nothing
// else, so this collector is worth the setup.

import { readFileSync } from 'node:fs'
import { dayWindow, emit, fail, parseArgs, prune, readConfig, resolveDayStartHour, resolveTimezone, secretAny } from './lib.mjs'

const args = parseArgs(process.argv.slice(2))
const cfg = args.config ? JSON.parse(readFileSync(args.config, 'utf8')) : readConfig()
if (!cfg) fail('No config found. Run the harvest-log setup first.')

const probe = Boolean(args.probe)
if (!args.from && !probe) fail('--from is required (YYYY-MM-DD)')

const slackCfg = cfg.sources?.slack || {}
const huddleCfg = slackCfg.huddles || {}
const messageCfg = slackCfg.messages || {}
const collectMessages = !args['no-messages'] && messageCfg.enabled !== false
const isIgnoredChannel = ignoreMatcher(messageCfg.ignoreChannels)

const from = String(args.from || '')
const to = String(args.to || args.from || '')
const tz = args.tz ? String(args.tz) : resolveTimezone(cfg)
// In probe mode there is no day to bound: we're hunting for any huddle at all,
// so sweep back `probeDays` and report whatever the API actually returns.
const probeDays = Number(args['probe-days'] || 90)
const startHour = args['day-start-hour'] !== undefined ? Number(args['day-start-hour']) : resolveDayStartHour(cfg)
const window = probe ? null : dayWindow(from, to, tz, startHour)

// Stopping early once a request is in flight has to be done by unwinding, not
// by process.exit(): killing the process while undici still holds a socket
// trips a libuv assertion on Windows and reports exit 127 instead of 1. Throw
// this, set process.exitCode, and let the event loop drain on its own.
const HALT = Symbol('halt')

function halt(payload) {
  emit(payload)
  process.exitCode = 1
  throw HALT
}

// --- Slack Web API -------------------------------------------------------
//
// Tier 3 methods allow ~50 calls/minute and answer a burst with 429 plus a
// Retry-After. Honour it rather than backing off blind: a day's sweep is one
// history call per conversation, and getting rate-limited halfway through
// would report a day as huddle-free when it wasn't.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const apiErrors = []

// Overridable so the normalization and coalescing can be tested against a
// fake Slack rather than only in production.
const apiBase = process.env.HARVEST_LOG_SLACK_API_BASE || process.env.HARVEST_DAY_SLACK_API_BASE || 'https://slack.com/api'

// Settings live under sources.slack.huddles; sources.slack is still consulted
// so a config that put them one level up keeps working.
function resolveToken() {
  if (typeof args.token === 'string') return args.token
  // Each name is looked up in the environment and then in the shared key store
  // at ~/.claude/.env-keys, in that order.
  //
  // HARVEST_DAY_SLACK_TOKEN is what this variable was called before the plugin
  // was renamed. Still honoured: the token lives in the user's environment, not
  // in this repo, and a rename here shouldn't silently degrade their huddles.
  const found = secretAny(
    'HARVEST_LOG_SLACK_TOKEN',
    'HARVEST_DAY_SLACK_TOKEN',
    huddleCfg.tokenEnv,
    slackCfg.tokenEnv,
  )
  if (found.value) return found.value
  return huddleCfg.token || slackCfg.token || null
}

const token = resolveToken()

async function api(method, params, { retries = 3 } = {}) {
  const body = new URLSearchParams(
    Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null)),
  )
  for (let attempt = 0; ; attempt++) {
    let res
    try {
      res = await fetch(`${apiBase}/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body,
      })
    } catch (e) {
      if (attempt >= retries) return { ok: false, error: `network: ${e.message}` }
      await sleep(500 * (attempt + 1))
      continue
    }
    if (res.status === 429) {
      if (attempt >= retries) return { ok: false, error: 'rate_limited' }
      await sleep((Number(res.headers.get('retry-after')) || 5) * 1000)
      continue
    }
    let data
    try {
      data = await res.json()
    } catch {
      return { ok: false, error: `unparseable response from ${method}` }
    }
    if (!data.ok) return { ok: false, error: data.error || `${method} failed` }
    return { ok: true, data }
  }
}

// Slack timestamps are seconds-with-fraction strings.
const toTs = (iso) => String(Math.floor(Date.parse(iso) / 1000))
const fromEpoch = (s) => (s ? new Date(Number(s) * 1000).toISOString() : null)

// A message is a call of some kind when it carries a `room`. Slack has used
// more than one value for `media_backend_type` over the years, so don't gate
// on it — keep it in the output instead and let the caller see what came back.
const isCall = (m) => Boolean(m && m.room) || m?.subtype === 'huddle_thread'

// Joins, leaves, topic changes and bot posts are not work. A real message has
// no subtype (or is a thread broadcast) and was typed by the user.
const AUTHORED_SUBTYPES = new Set([undefined, null, '', 'thread_broadcast', 'me_message'])
const isAuthored = (m, selfId) =>
  Boolean(m)
  && m.user === selfId
  && !m.bot_id
  && !isCall(m)
  && AUTHORED_SUBTYPES.has(m.subtype)
  && String(m.text || '').trim().length > 0

// Channels the user says aren't work. Matched case-insensitively as regexes
// against the channel name, the same rule every other `match` in this skill
// uses. DMs are never excluded by name — they have no name to match — so a
// chatty DM stays countable and it is the substance judgement that filters it.
function ignoreMatcher(patterns) {
  const res = (patterns || []).map((p) => {
    try {
      return new RegExp(p, 'i')
    } catch {
      return null
    }
  }).filter(Boolean)
  return (name) => Boolean(name) && res.some((re) => re.test(name))
}

// Modest concurrency: enough to make a sweep of 80 conversations bearable,
// low enough that the 429 path stays the exception.
async function pool(items, size, fn) {
  const results = []
  let next = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

async function main() {
  if (!token) {
    // Not a hard failure: a missing token is an expected state, and the skill
    // has a degraded path for it. Name the path, so it isn't guessed at.
    halt({
      ok: false,
      source: 'slack',
      error: 'no Slack user token configured',
      fallback: 'mcp',
      hint: 'set $HARVEST_LOG_SLACK_TOKEN to an xoxp- token, or sources.slack.tokenEnv to the name of the variable holding it',
    })
  }

  const auth = await api('auth.test', {})
  if (!auth.ok) {
    halt({
      ok: false,
      source: 'slack',
      error:
        auth.error === 'invalid_auth' || auth.error === 'not_authed'
          ? 'Slack token rejected (invalid_auth) — is it an xoxp- user token, and is it still valid?'
          : `Slack auth.test failed: ${auth.error}`,
      fallback: 'mcp',
    })
  }
  const selfId = auth.data.user_id

  // --- Conversations -----------------------------------------------------

  const types = huddleCfg.conversationTypes || 'im,mpim,private_channel,public_channel'
  const maxConversations = Number(args['max-conversations'] || huddleCfg.maxConversations || 80)

  // An `allow` list short-circuits discovery entirely — cheaper, and the right
  // answer for someone who only ever huddles with the same handful of people.
  const allow = huddleCfg.conversations || []
  let conversations = []
  let capped = false

  if (allow.length) {
    conversations = allow.map((id) => ({ id, _fromAllowList: true }))
  } else {
    let cursor
    for (let page = 0; page < 20; page++) {
      const r = await api('users.conversations', { types, exclude_archived: 'true', limit: '200', cursor })
      if (!r.ok) {
        halt({ ok: false, source: 'slack', error: `Slack users.conversations failed: ${r.error}`, fallback: 'mcp' })
      }
      conversations.push(...(r.data.channels || []))
      cursor = r.data.response_metadata?.next_cursor
      if (!cursor) break
    }
    if (conversations.length > maxConversations) {
      capped = true
      conversations.length = maxConversations
    }
  }

  // --- User names --------------------------------------------------------

  const userCache = new Map()

  async function userName(id) {
    if (!id) return null
    if (userCache.has(id)) return userCache.get(id)
    const r = await api('users.info', { user: id })
    const p = r.ok ? r.data.user : null
    const name = p ? p.profile?.real_name || p.profile?.display_name || p.name || id : id
    userCache.set(id, name)
    return name
  }

  // --- History sweep -----------------------------------------------------

  async function history(id) {
    const params = probe
      ? { channel: id, limit: '200', oldest: String(Math.floor(Date.now() / 1000) - probeDays * 86400) }
      : { channel: id, limit: '200', oldest: toTs(window.utcStart), latest: toTs(window.utcEnd), inclusive: 'false' }
    const messages = []
    let cursor
    for (let page = 0; page < 5; page++) {
      const r = await api('conversations.history', { ...params, cursor })
      if (!r.ok) {
        // One inaccessible conversation must not sink the sweep — but it does
        // mean the day's evidence is incomplete, so it goes in the output.
        apiErrors.push({ conversation: id, error: r.error })
        return messages
      }
      messages.push(...(r.data.messages || []))
      if (!r.data.has_more) break
      cursor = r.data.response_metadata?.next_cursor
      if (!cursor) break
    }
    return messages
  }

  // One sweep, two answers. The history call that finds huddles already carries
  // every ordinary message in the conversation, so collecting the user's own
  // messages costs nothing beyond the filtering — and messages are the densest
  // timestamped evidence there is, dense enough to describe the shape of a day
  // that commits alone cannot. Throwing them away here was the expensive part.
  const perConversation = await pool(conversations, 4, async (conv) => {
    const all = await history(conv.id)
    return {
      conv,
      calls: all.filter(isCall),
      authored: collectMessages ? all.filter((m) => isAuthored(m, selfId)) : [],
    }
  })

  // --- Probe mode --------------------------------------------------------
  //
  // The point of this mode: nobody should have to trust a field name. Run it
  // once after setting the token up and read what Slack actually returns.

  if (probe) {
    const limit = Number(args['probe-limit'] || 3)
    const samples = []
    for (const { conv, calls } of perConversation) {
      for (const m of calls) {
        if (samples.length >= limit) break
        samples.push({ conversation: conv.id, message: m })
      }
    }
    emit({
      ok: true,
      source: 'slack',
      mode: 'probe',
      self: selfId,
      conversationsScanned: conversations.length,
      callMessagesFound: perConversation.reduce((n, c) => n + c.calls.length, 0),
      lookbackDays: probeDays,
      errors: apiErrors,
      samples,
      note: 'Check that room.date_start, room.date_end and room.participant_history are present and populated. If date_end is 0 or absent on ended huddles, durations are not available from this API and the collector will report durationUnknown.',
    })
    return
  }

  // --- Normalize ---------------------------------------------------------

  const raw = []
  for (const { conv, calls } of perConversation) {
    for (const m of calls) {
      const room = m.room || {}
      const attendees = room.participant_history || room.participants || []

      // A channel huddle the user never joined is someone else's meeting.
      // participant_history is the only field that answers "did they attend";
      // when it's missing entirely, keep the huddle but say the attendance is
      // unverified rather than silently dropping or silently claiming it.
      const attendanceKnown = Array.isArray(room.participant_history) && room.participant_history.length > 0
      if (attendanceKnown && !room.participant_history.includes(selfId) && !args['all-participants']) continue

      raw.push({
        conv,
        startEpoch: Number(room.date_start || m.ts),
        endEpoch: room.date_end ? Number(room.date_end) : null,
        participants: attendees.filter((u) => u !== selfId),
        attendanceKnown,
        backend: room.media_backend_type || null,
        title: room.name || null,
        threadTs: m.thread_ts || m.ts,
      })
    }
  }

  // Rejoining a huddle starts a new one as far as the API is concerned, so a
  // single conversation routinely logs two or three within a few minutes. Left
  // alone that reads as three meetings; coalesce them into the one they were.
  const gapMinutes = Number(huddleCfg.coalesceGapMinutes ?? 10)
  const byConversation = new Map()
  for (const h of raw) {
    const list = byConversation.get(h.conv.id) || []
    list.push(h)
    byConversation.set(h.conv.id, list)
  }

  const merged = []
  for (const list of byConversation.values()) {
    list.sort((a, b) => a.startEpoch - b.startEpoch)
    let current = null
    for (const h of list) {
      const gap = current ? h.startEpoch - (current.endEpoch ?? current.startEpoch) : Infinity
      if (current && gap <= gapMinutes * 60) {
        current.endEpoch = h.endEpoch ? Math.max(current.endEpoch ?? 0, h.endEpoch) : current.endEpoch
        current.participants = [...new Set([...current.participants, ...h.participants])]
        current.attendanceKnown = current.attendanceKnown || h.attendanceKnown
        current.segments++
        continue
      }
      if (current) merged.push(current)
      current = { ...h, segments: 1 }
    }
    if (current) merged.push(current)
  }

  // `fallbackNames` covers a pinned conversation, where discovery never ran and
  // so nothing says who the DM is with — the huddle's own participants do.
  async function describeConversation(conv, fallbackNames) {
    if (conv.is_im || (conv._fromAllowList && String(conv.id).startsWith('D'))) {
      if (conv.user) return { kind: 'dm', name: await userName(conv.user) }
      return { kind: 'dm', name: fallbackNames.join(', ') || 'DM' }
    }
    if (conv.is_mpim) return { kind: 'group-dm', name: conv.name || 'group DM' }
    return { kind: 'channel', name: conv.name ? `#${conv.name}` : conv.id }
  }

  const out = []
  for (const h of merged) {
    const names = []
    for (const id of h.participants) names.push(await userName(id))
    const where = await describeConversation(h.conv, names)
    const durationMinutes = h.endEpoch ? Math.round((h.endEpoch - h.startEpoch) / 60) : null
    out.push(
      prune({
        start: fromEpoch(h.startEpoch),
        end: fromEpoch(h.endEpoch),
        // Rounded to the pipeline's 0.25 only at presentation time — the true
        // figure lives here.
        durationMinutes,
        durationUnknown: durationMinutes === null ? true : null,
        with: names,
        where: where.name,
        whereKind: where.kind,
        title: h.title,
        // >1 means the huddle was rejoined and the segments were merged. Worth
        // showing: it usually means a call that paused rather than one that ran
        // continuously for the full span.
        segments: h.segments > 1 ? h.segments : null,
        attendanceUnverified: h.attendanceKnown ? null : true,
        backend: h.backend,
        permalinkHint: `${h.conv.id}/${h.threadTs}`,
      }),
    )
  }
  out.sort((a, b) => String(a.start).localeCompare(String(b.start)))

  const withDuration = out.filter((h) => h.durationMinutes != null)
  const totalMinutes = withDuration.reduce((n, h) => n + h.durationMinutes, 0)

  // --- Messages ----------------------------------------------------------

  const messages = []
  for (const { conv, authored } of perConversation) {
    if (!authored.length) continue
    const where = await describeConversation(conv, [])
    const isDm = where.kind === 'dm' || where.kind === 'group-dm'
    const ignored = isIgnoredChannel(where.name)
    for (const m of authored) {
      const text = String(m.text || '')
      messages.push(prune({
        at: fromEpoch(String(m.ts).split('.')[0]),
        where: where.name,
        whereKind: where.kind,
        chars: text.length,
        threadReply: m.thread_ts && m.thread_ts !== m.ts ? true : null,
        // Excerpts are how the scorer tells a design argument from "👍", and
        // mapping.md sizes messages on exactly that. But a DM's contents are
        // never ours to repeat — the note rule is absolute — so DMs travel as
        // shape only: when they were sent and how long they were.
        excerpt: !isDm && !ignored ? text.slice(0, 160) : null,
        // Kept rather than dropped: a silently shorter list is indistinguishable
        // from a quiet day, and the count of what was excluded is cheap honesty.
        ignoredChannel: ignored ? true : null,
      }))
    }
  }
  messages.sort((a, b) => String(a.at).localeCompare(String(b.at)))
  const countedMessages = messages.filter((m) => !m.ignoredChannel)

  // Shaped for build-timeline.mjs, so this whole payload can be handed to it
  // as --events with no reshaping in between. Huddles are spans; messages are
  // points. Ignored channels are absent — they are not work, and the timeline
  // is about when work happened.
  const events = [
    ...out.map((h) => prune({
      start: h.start,
      end: h.end,
      kind: 'huddle',
      label: `huddle with ${(h.with || []).join(', ') || h.where}`,
    })).filter((e) => e.start && e.end),
    ...countedMessages.map((m) => ({ t: m.at, kind: 'slack', label: m.where })),
  ]

  emit(
    prune({
      ok: true,
      source: 'slack',
      from,
      to,
      window,
      self: selfId,
      huddles: out,
      messages: collectMessages ? messages : null,
      events,
      summary: {
        count: out.length,
        totalMinutes,
        totalHours: Math.round((totalMinutes / 60) * 100) / 100,
        unknownDuration: out.length - withDuration.length,
        messages: collectMessages ? countedMessages.length : null,
        messagesIgnored: collectMessages ? messages.length - countedMessages.length : null,
      },
      conversationsScanned: conversations.length,
      // Both of these mean the sweep did not see everything. Put them in the
      // proposal's footer: a huddle that wasn't found looks identical to a day
      // without huddles.
      truncated: capped || apiErrors.length > 0 || null,
      truncatedNote: capped
        ? `scanned only the first ${maxConversations} conversations — raise sources.slack.huddles.maxConversations, or pin the ones that matter in sources.slack.huddles.conversations`
        : null,
      errors: apiErrors,
    }),
  )
}

try {
  await main()
} catch (e) {
  if (e !== HALT) {
    emit({ ok: false, source: 'slack', error: String(e?.message || e), fallback: 'mcp' })
    process.exitCode = 1
  }
}
