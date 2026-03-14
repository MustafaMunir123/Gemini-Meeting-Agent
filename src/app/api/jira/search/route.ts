import { NextRequest, NextResponse } from 'next/server'
import https from 'https'
import { URL } from 'url'

<<<<<<< Updated upstream
const getJiraConfig = () => ({
  baseUrl: (process.env['JIRA_BASE_URL'] ?? '').replace(/\/$/, ''),
  email: process.env['JIRA_EMAIL'],
  apiKey: process.env['JIRA_API_KEY'],
})
=======
// When set (e.g. JIRA_INSECURE_TLS=1), Jira API requests skip TLS cert verification (fixes "unable to get local issuer certificate" on some systems).
const jiraInsecureTls =
  process.env['JIRA_INSECURE_TLS'] === '1' ||
  process.env['JIRA_INSECURE_TLS'] === 'true' ||
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0'
const jiraHttpsAgent = jiraInsecureTls ? new https.Agent({ rejectUnauthorized: false }) : undefined

async function jiraFetch(
  url: string,
  options: { method?: string; headers?: Record<string, string> }
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }> {
  if (!jiraHttpsAgent) {
    const res = await fetch(url, options)
    return {
      ok: res.ok,
      status: res.status,
      json: () => res.json(),
      text: () => res.text(),
    }
  }
  const u = new URL(url)
  if (u.protocol !== 'https:') {
    const res = await fetch(url, options)
    return { ok: res.ok, status: res.status, json: () => res.json(), text: () => res.text() }
  }
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: options.method || 'GET',
        headers: options.headers,
        agent: jiraHttpsAgent,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          resolve({
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            json: async () => JSON.parse(body) as unknown,
            text: async () => body,
          })
        })
      }
    )
    req.on('error', reject)
    req.end()
  })
}

function getJiraConfig() {
  const base = (process.env['JIRA_BASE_URL'] ?? '')?.replace(/\/$/, '')
  const email = process.env['JIRA_EMAIL']
  const apiKey = process.env['JIRA_API_KEY']
  return { baseUrl: base, email: email, apiKey: apiKey }
}
>>>>>>> Stashed changes

type JiraIssue = {
  key: string
  summary?: string
  status?: string
  issuetype?: string
  labels?: string[]
  assignee?: string
  parentKey?: string
  parentSummary?: string
  parentAssignee?: string
}

<<<<<<< Updated upstream
function getAuthHeader(cfg: ReturnType<typeof getJiraConfig>): string {
  if (!cfg.apiKey) throw new Error('Missing JIRA_API_KEY')
  if (cfg.email) {
    const encoded = Buffer.from(`${cfg.email}:${cfg.apiKey}`).toString('base64')
    return `Basic ${encoded}`
  }
  return `Bearer ${cfg.apiKey}`
}

async function fetchJiraIssues(cfg: ReturnType<typeof getJiraConfig>, jql: string, maxResults: number): Promise<JiraIssue[]> {
  if (!cfg.baseUrl) throw new Error('Missing JIRA_BASE_URL')
=======
function getAuthHeader(config: { apiKey: string | undefined; email: string | undefined }): string {
  if (!config.apiKey) throw new Error('Missing JIRA_API_KEY')
  if (config.email) {
    const encoded = Buffer.from(`${config.email}:${config.apiKey}`).toString('base64')
    return `Basic ${encoded}`
  }
  return `Bearer ${config.apiKey}`
}

async function fetchJiraIssues(
  config: { baseUrl: string; apiKey: string | undefined; email: string | undefined },
  jql: string,
  maxResults: number
): Promise<JiraIssue[]> {
  if (!config.baseUrl) throw new Error('Missing JIRA_BASE_URL')
>>>>>>> Stashed changes
  const params = new URLSearchParams({
    jql,
    maxResults: String(maxResults),
    fields: 'summary,status,issuetype,labels,assignee,parent',
  })
<<<<<<< Updated upstream
  const res = await fetch(`${cfg.baseUrl}/rest/api/3/search/jql?${params}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: getAuthHeader(cfg),
=======
  const res = await jiraFetch(`${config.baseUrl}/rest/api/3/search/jql?${params}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: getAuthHeader(config),
>>>>>>> Stashed changes
    },
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Jira API ${res.status}: ${err}`)
  }
  type RawIssue = {
    key: string
    fields?: {
      summary?: string
      status?: { name?: string }
      issuetype?: { name?: string }
      labels?: string[]
      assignee?: { displayName?: string }
      parent?: { key?: string; fields?: { summary?: string } }
    }
  }
  const data = (await res.json()) as { issues?: RawIssue[]; values?: RawIssue[] }
  const rawIssues = data.issues ?? data.values ?? []
  const issues: JiraIssue[] = rawIssues.map((i) => ({
    key: i.key,
    summary: i.fields?.summary,
    status: i.fields?.status?.name,
    issuetype: i.fields?.issuetype?.name,
    labels: Array.isArray(i.fields?.labels) ? i.fields.labels : undefined,
    assignee: i.fields?.assignee?.displayName,
    parentKey: i.fields?.parent?.key,
    parentSummary: i.fields?.parent?.fields?.summary,
    parentAssignee: undefined, // filled below if we have parent keys
  }))

  // Fetch parent summary and assignee for issues that have a parent (search may not return parent.fields)
  const parentKeys = Array.from(new Set(issues.map((i) => i.parentKey).filter(Boolean))) as string[]
  const parentMeta: Record<string, { summary?: string; assignee?: string }> = {}
  for (const pkey of parentKeys) {
    try {
<<<<<<< Updated upstream
      const pres = await fetch(`${cfg.baseUrl}/rest/api/3/issue/${pkey}?fields=summary,assignee`, {
        headers: { Accept: 'application/json', Authorization: getAuthHeader(cfg) },
=======
      const pres = await jiraFetch(`${config.baseUrl}/rest/api/3/issue/${pkey}?fields=summary,assignee`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: getAuthHeader(config) },
>>>>>>> Stashed changes
      })
      if (pres.ok) {
        const pdata = (await pres.json()) as { fields?: { summary?: string; assignee?: { displayName?: string } } }
        parentMeta[pkey] = {
          summary: pdata.fields?.summary ?? issues.find((i) => i.parentKey === pkey)?.parentSummary,
          assignee: pdata.fields?.assignee?.displayName,
        }
      }
    } catch {
      // ignore per-parent errors
    }
  }
  issues.forEach((i) => {
    if (!i.parentKey) return
    const meta = parentMeta[i.parentKey]
    if (meta) {
      if (meta.summary) i.parentSummary = meta.summary
      if (meta.assignee) i.parentAssignee = meta.assignee
    }
  })

  return issues
}

function buildIssuesContext(issues: JiraIssue[], baseUrl: string): string {
  const url = baseUrl || 'https://your-domain.atlassian.net'
  return issues
    .map((i) => {
      const lines = [
        `key: ${i.key}`,
        `summary: ${i.summary ?? '(no summary)'}`,
        `type: ${i.issuetype ?? '?'}`,
        `status: ${i.status ?? '?'}`,
        `labels: ${i.labels?.length ? i.labels.join(', ') : '—'}`,
        `assignee: ${i.assignee ?? 'Unassigned'}`,
        `parentKey: ${i.parentKey ?? '—'}`,
        `parentSummary: ${i.parentSummary ?? '—'}`,
        `parentAssignee: ${i.parentAssignee ?? '—'}`,
        `link: ${url}/browse/${i.key}`,
      ]
      return lines.join('\n')
    })
    .join('\n\n')
}

async function answerWithGemini(query: string, issuesContext: string): Promise<{ answer: string; link: string; details: string }> {
  const apiKey = process.env['NEXT_PUBLIC_GEMINI_API_KEY'] || process.env['GEMINI_API_KEY']
  if (!apiKey) throw new Error('Missing Gemini API key')
  const prompt = `You are a meeting assistant. The user asked in the meeting: "${query}"

Below are Jira issues in KEY_NAME: KEY_VALUE format (one issue per block). Pick only the ticket(s) that match what the user asked for (one ticket if they asked for a specific one; at most 5 if they asked for several).

${issuesContext || '(No issues returned.)'}

Respond in JSON only, with exactly these keys (no markdown, no extra text):
- "answer": A very short spoken reply (1-2 sentences) suitable for voice, e.g. "I found something relevant: [brief summary]. I'll share the link in chat."
- "link": The best matching issue link or empty string if nothing matches.
- "details": A few lines of detail to paste in meeting chat (include the link and a brief summary).`

  const model = process.env['JIRA_SEARCH_GEMINI_MODEL'] || process.env['DRIVE_SEARCH_GEMINI_MODEL'] || 'gemini-2.5-flash'
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    }
  )
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini error: ${res.status} ${err}`)
  }
  const data = await res.json()
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Empty Gemini response')
  const parsed = JSON.parse(text.trim()) as { answer?: string; link?: string; details?: string }
  return {
    answer: typeof parsed.answer === 'string' ? parsed.answer : "I couldn't find a matching Jira ticket.",
    link: typeof parsed.link === 'string' ? parsed.link : '',
    details: typeof parsed.details === 'string' ? parsed.details : '',
  }
}

function toErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: unknown }).cause
    if (cause instanceof Error) return `${e.message}: ${cause.message}`
    if (cause != null) return `${e.message}: ${String(cause)}`
    return e.message
  }
  return String(e)
}

export async function POST(request: NextRequest) {
<<<<<<< Updated upstream
  const cfg = getJiraConfig()
=======
>>>>>>> Stashed changes
  const secret = process.env['JIRA_SEARCH_SECRET']
  if (secret) {
    const header = request.headers.get('x-jira-search-secret') || request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (header !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

<<<<<<< Updated upstream
  if (!cfg.baseUrl || !cfg.apiKey) {
    return NextResponse.json({ error: 'JIRA_BASE_URL and JIRA_API_KEY (and JIRA_EMAIL for Cloud) are required' }, { status: 500 })
=======
  const config = getJiraConfig()
  if (!config.baseUrl || !config.apiKey) {
    return NextResponse.json(
      { error: 'JIRA_BASE_URL and JIRA_API_KEY (and JIRA_EMAIL for Cloud) are required. Check env vars are set at runtime.' },
      { status: 500 }
    )
>>>>>>> Stashed changes
  }

  let body: { query?: string; jql?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const query = typeof body.query === 'string' ? body.query.trim() : ''
  if (!query) {
    return NextResponse.json({ error: 'query is required' }, { status: 400 })
  }

<<<<<<< Updated upstream
  const defaultJql = (process.env['JIRA_DEFAULT_JQL'] ?? '').trim() || 'updated >= -90d ORDER BY updated DESC'
=======
  const defaultJql = (process.env['JIRA_DEFAULT_JQL'] ?? '')?.trim() || 'updated >= -90d ORDER BY updated DESC'
>>>>>>> Stashed changes
  const jql = typeof body.jql === 'string' && body.jql.trim() ? body.jql.trim() : defaultJql
  const maxResults = 50

  try {
<<<<<<< Updated upstream
    const issues = await fetchJiraIssues(cfg, jql, maxResults)
    const issuesContext = buildIssuesContext(issues, cfg.baseUrl)
    const result = await answerWithGemini(query, issuesContext)
=======
    let issues: JiraIssue[]
    try {
      issues = await fetchJiraIssues(config, jql, maxResults)
    } catch (e) {
      throw new Error(`Jira API request failed (${config.baseUrl}). ${toErrorMessage(e)}`)
    }
    const issuesContext = buildIssuesContext(issues, config.baseUrl)
    let result: { answer: string; link: string; details: string }
    try {
      result = await answerWithGemini(query, issuesContext)
    } catch (e) {
      throw new Error(`Gemini answer failed. ${toErrorMessage(e)}`)
    }
>>>>>>> Stashed changes
    // Use LLM's details only (never fall back to full issue list—we want only the asked-for ticket(s))
    const details =
      typeof result.details === 'string' && result.details.trim()
        ? result.details.trim()
        : issues.length > 0
          ? `${result.answer || 'Jira search completed.'}${result.link ? '\n' + result.link : ''}`
          : result.answer || 'No matching Jira tickets found.'
    return NextResponse.json({ ...result, details })
  } catch (e) {
    let message = e instanceof Error ? e.message : toErrorMessage(e)
    if (/certificate|issuer certificate|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
      message += ' Set JIRA_INSECURE_TLS=1 to skip TLS verification (development only).'
    }
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
