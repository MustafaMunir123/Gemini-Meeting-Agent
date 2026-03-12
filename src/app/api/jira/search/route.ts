import { NextRequest, NextResponse } from 'next/server'

const JIRA_BASE_URL = process.env.JIRA_BASE_URL?.replace(/\/$/, '')
const JIRA_EMAIL = process.env.JIRA_EMAIL
const JIRA_API_KEY = process.env.JIRA_API_KEY

type JiraIssue = { key: string; summary?: string; status?: string; issuetype?: string }

function getAuthHeader(): string {
  if (!JIRA_API_KEY) throw new Error('Missing JIRA_API_KEY')
  if (JIRA_EMAIL) {
    const encoded = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_KEY}`).toString('base64')
    return `Basic ${encoded}`
  }
  return `Bearer ${JIRA_API_KEY}`
}

async function fetchJiraIssues(jql: string, maxResults: number): Promise<JiraIssue[]> {
  if (!JIRA_BASE_URL) throw new Error('Missing JIRA_BASE_URL')
  const params = new URLSearchParams({
    jql,
    maxResults: String(maxResults),
    fields: 'summary,status,issuetype',
  })
  const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/search/jql?${params}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: getAuthHeader(),
    },
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Jira API ${res.status}: ${err}`)
  }
  const data = (await res.json()) as { issues?: Array<{ key: string; fields?: { summary?: string; status?: { name?: string }; issuetype?: { name?: string } } }>; values?: typeof data.issues }
  const issues = data.issues ?? data.values ?? []
  return issues.map((i) => ({
    key: i.key,
    summary: i.fields?.summary,
    status: i.fields?.status?.name,
    issuetype: i.fields?.issuetype?.name,
  }))
}

function buildIssuesContext(issues: JiraIssue[]): string {
  const baseUrl = JIRA_BASE_URL || 'https://your-domain.atlassian.net'
  return issues
    .map(
      (i) =>
        `[${i.key}] ${i.summary || '(no summary)'} | Status: ${i.status || '?'} | Type: ${i.issuetype || '?'} | Link: ${baseUrl}/browse/${i.key}`
    )
    .join('\n')
}

async function answerWithGemini(query: string, issuesContext: string): Promise<{ answer: string; link: string; details: string }> {
  const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY || process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('Missing Gemini API key')
  const prompt = `You are a meeting assistant. The user asked: "${query}"

Below are Jira issues (key, summary, status, type, link). Pick the best match(es) for the query.

${issuesContext || '(No issues returned.)'}

Respond in JSON only, with exactly these keys (no markdown, no extra text):
- "answer": A very short spoken reply (1-2 sentences), e.g. "I found a ticket: [brief summary]. I'll share the link in chat."
- "link": The best matching issue link or empty string if nothing matches.
- "details": A few lines for meeting chat (include the link and a brief summary).`

  const model = process.env.JIRA_SEARCH_GEMINI_MODEL || process.env.DRIVE_SEARCH_GEMINI_MODEL || 'gemini-2.5-flash'
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
  const secret = process.env.JIRA_SEARCH_SECRET
  if (secret) {
    const header = request.headers.get('x-jira-search-secret') || request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (header !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  if (!JIRA_BASE_URL || !JIRA_API_KEY) {
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

  const defaultJql = process.env.JIRA_DEFAULT_JQL?.trim() || 'updated >= -90d ORDER BY updated DESC'
  const jql = typeof body.jql === 'string' && body.jql.trim() ? body.jql.trim() : defaultJql
  const maxResults = 50

  try {
    const issues = await fetchJiraIssues(jql, maxResults)
    const issuesContext = buildIssuesContext(issues)
    const result = await answerWithGemini(query, issuesContext)
    return NextResponse.json(result)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Jira search failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
