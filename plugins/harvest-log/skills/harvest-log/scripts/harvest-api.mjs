// Harvest REST helpers for harvest-log.
//
// Why these exist alongside a perfectly good Harvest MCP: volume. Setup reads
// 90 days of entries, the catch-up scan reads two weeks of them, and every one
// that arrives through the MCP arrives in the conversation. Through here they
// arrive in a variable, and the scripts print the handful of numbers actually
// derived from them.
//
// Credentials resolve the way every key in this marketplace does: the
// environment first, then the shared store at `~/.claude/.env-keys`. Names are
// $HARVEST_TOKEN and $HARVEST_ACCOUNT_ID by default, overridable via
// harvest.tokenEnv / harvest.accountIdEnv. The same pair serves harvest-review,
// so one personal access token covers both plugins.
//
// Nothing here writes except postTimeEntry, which is called by exactly one
// script (log-time.mjs) and only after the user has confirmed a table.

import { secretAny } from './lib.mjs'

const BASE = process.env.HARVEST_LOG_API_BASE || 'https://api.harvestapp.com/api/v2'

export function credentials(cfg) {
  const tokenEnv = cfg?.harvest?.tokenEnv || 'HARVEST_TOKEN'
  const accountEnv = cfg?.harvest?.accountIdEnv || 'HARVEST_ACCOUNT_ID'
  const token = secretAny(tokenEnv, 'HARVEST_LOG_TOKEN')
  const account = secretAny(accountEnv, 'HARVEST_LOG_ACCOUNT_ID')
  return {
    token: token.value,
    accountId: account.value,
    tokenEnv,
    accountEnv,
    // Where each came from, for doctor. Never the values.
    source: { token: token.source, accountId: account.source },
  }
}

export function hasCredentials(cfg) {
  const c = credentials(cfg)
  return Boolean(c.token && c.accountId)
}

export function missingCredentialsMessage(cfg) {
  const c = credentials(cfg)
  return (
    `Harvest credentials missing — set ${c.tokenEnv} and ${c.accountEnv} (\`node keys.mjs --set ${c.tokenEnv}\`), or fall back to the Harvest MCP. ` +
    'Create a personal access token at https://id.getharvest.com/developers.'
  )
}

function headers(creds) {
  return {
    Authorization: `Bearer ${creds.token}`,
    'Harvest-Account-Id': String(creds.accountId),
    'User-Agent': 'harvest-log (claude-code plugin)',
    'Content-Type': 'application/json',
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function request(method, path, creds, body) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`
  let res
  try {
    res = await fetch(url, { method, headers: headers(creds), body: body ? JSON.stringify(body) : undefined })
  } catch (e) {
    return { ok: false, error: `network error: ${e.message}` }
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, error: 'Harvest rejected the token (401/403) — check the PAT and the account id' }
  }
  if (res.status === 429) {
    return { ok: false, status: 429, error: 'rate limited', retryAfter: Number(res.headers.get('retry-after') || 15) }
  }
  if (!res.ok) {
    // Harvest explains rejected writes in the body, and those explanations are
    // the useful part: "task not assigned to project" is actionable, "HTTP 422"
    // is not.
    let detail = ''
    try {
      detail = JSON.stringify(await res.json())
    } catch {
      /* body wasn't JSON */
    }
    return { ok: false, status: res.status, error: `HTTP ${res.status}${detail ? ` ${detail}` : ''}` }
  }
  return { ok: true, data: await res.json() }
}

export async function get(path, creds) {
  for (let attempt = 0; ; attempt++) {
    const r = await request('GET', path, creds)
    if (r.ok || r.status !== 429 || attempt >= 3) return r
    await sleep((r.retryAfter || 15) * 1000)
  }
}

// Walk every page. `links.next` is followed when present; otherwise page numbers
// are appended to the *original* path, never to the previous URL, which would
// stack `page=2&page=3` and loop.
export async function paged(path, creds, key, { maxPages = 100 } = {}) {
  const items = []
  let next = path
  let pages = 0
  while (next && pages < maxPages) {
    const r = await get(next, creds)
    if (!r.ok) return { ok: false, error: r.error, items, pages }
    pages++
    items.push(...(r.data[key] || []))
    if (r.data.links?.next) next = r.data.links.next
    else if (r.data.next_page) next = `${path}${path.includes('?') ? '&' : '?'}page=${r.data.next_page}`
    else next = null
  }
  return { ok: true, items, pages, truncated: pages >= maxPages ? true : null }
}

// The one write in this plugin.
//
// `spent_date` is the API's name for what the MCP calls spent_at. Hours are a
// plain duration: this account has no rounding and no timestamp timers, so no
// started_time / ended_time is ever sent.
export async function postTimeEntry(creds, { projectId, taskId, spentDate, hours, notes, userId }) {
  return request('POST', '/time_entries', creds, {
    project_id: projectId,
    task_id: taskId,
    spent_date: spentDate,
    hours,
    notes: notes || undefined,
    user_id: userId || undefined,
  })
}
