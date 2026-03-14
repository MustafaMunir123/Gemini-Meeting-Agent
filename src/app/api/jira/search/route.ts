import { NextRequest, NextResponse } from 'next/server'

const getJiraConfig = () => ({
  baseUrl: (process.env['JIRA_BASE_URL'] ?? '').replace(/\/$/, ''),
  email: process.env['JIRA_EMAIL'],
  apiKey: process.env['JIRA_API_KEY'],
})

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
  const params = new URLSearchParams({
    jql,
    maxResults: String(maxResults),
    fields: 'summary,status,issuetype,labels,assignee,parent',
  })
  const res = await fetch(`${cfg.baseUrl}/rest/api/3/search/jql?${params}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: getAuthHeader(cfg),
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
      const pres = await fetch(`${cfg.baseUrl}/rest/api/3/issue/${pkey}?fields=summary,assignee`, {
        headers: { Accept: 'application/json', Authorization: getAuthHeader(cfg) },
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

export async function POST(request: NextRequest) {
  const cfg = getJiraConfig()
  const secret = process.env['JIRA_SEARCH_SECRET']
  if (secret) {
    const header = request.headers.get('x-jira-search-secret') || request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (header !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  if (!cfg.baseUrl || !cfg.apiKey) {
    return NextResponse.json({ error: 'JIRA_BASE_URL and JIRA_API_KEY (and JIRA_EMAIL for Cloud) are required' }, { status: 500 })
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

  const defaultJql = (process.env['JIRA_DEFAULT_JQL'] ?? '').trim() || 'updated >= -90d ORDER BY updated DESC'
  const jql = typeof body.jql === 'string' && body.jql.trim() ? body.jql.trim() : defaultJql
  const maxResults = 50

  try {
    const issues = await fetchJiraIssues(cfg, jql, maxResults)
    const issuesContext = buildIssuesContext(issues, cfg.baseUrl)
    const result = await answerWithGemini(query, issuesContext)
    // Use LLM's details only (never fall back to full issue list—we want only the asked-for ticket(s))
    const details =
      typeof result.details === 'string' && result.details.trim()
        ? result.details.trim()
        : issues.length > 0
          ? `${result.answer || 'Jira search completed.'}${result.link ? '\n' + result.link : ''}`
          : result.answer || 'No matching Jira tickets found.'
    return NextResponse.json({ ...result, details })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Jira search failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
