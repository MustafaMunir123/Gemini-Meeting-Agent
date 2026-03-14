import { NextRequest, NextResponse } from 'next/server'

const getJiraConfig = () => ({
  baseUrl: (process.env['JIRA_BASE_URL'] ?? '').replace(/\/$/, ''),
  email: process.env['JIRA_EMAIL'],
  apiKey: process.env['JIRA_API_KEY'],
  projectKey: (process.env['JIRA_PROJECT_KEY'] ?? '').trim(),
  boardId: (process.env['JIRA_BOARD_ID'] ?? '').trim(),
})

function getAuthHeader(cfg: ReturnType<typeof getJiraConfig>): string {
  if (!cfg.apiKey) throw new Error('Missing JIRA_API_KEY')
  if (cfg.email) {
    const encoded = Buffer.from(`${cfg.email}:${cfg.apiKey}`).toString('base64')
    return `Basic ${encoded}`
  }
  return `Bearer ${cfg.apiKey}`
}

/** Build ADF description from plain text (one paragraph per line). */
function descriptionToAdf(text: string): { type: 'doc'; version: 1; content: unknown[] } {
  const lines = text.split(/\n/).filter((s) => s.trim().length > 0)
  const content =
    lines.length > 0
      ? lines.map((line) => ({
          type: 'paragraph',
          content: [{ type: 'text' as const, text: line }],
        }))
      : [{ type: 'paragraph', content: [{ type: 'text' as const, text: '(No description)' }] }]
  return { type: 'doc', version: 1, content }
}

/** Get project key from an existing issue (by key). */
async function getProjectKeyFromIssue(issueKey: string, cfg: ReturnType<typeof getJiraConfig>): Promise<string> {
  if (!cfg.baseUrl) throw new Error('Missing JIRA_BASE_URL')
  const res = await fetch(`${cfg.baseUrl}/rest/api/3/issue/${issueKey}?fields=project`, {
    headers: { Accept: 'application/json', Authorization: getAuthHeader(cfg) },
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Jira get issue ${res.status}: ${err}`)
  }
  const data = (await res.json()) as { fields?: { project?: { key?: string } } }
  const key = data.fields?.project?.key
  if (!key) throw new Error(`Could not get project for issue ${issueKey}`)
  return key
}

/** Add issue to the active or latest sprint for the board. */
async function addIssueToLatestSprint(issueKey: string, cfg: ReturnType<typeof getJiraConfig>, boardIdOverride?: string): Promise<void> {
  const boardId = (boardIdOverride || cfg.boardId)?.trim()
  if (!cfg.baseUrl || !boardId) return
  const headers = { Accept: 'application/json', Authorization: getAuthHeader(cfg), 'Content-Type': 'application/json' }
  const sprintsRes = await fetch(
    `${cfg.baseUrl}/rest/agile/1.0/board/${boardId}/sprint?state=active`,
    { headers }
  )
  if (!sprintsRes.ok) return
  const sprintsData = (await sprintsRes.json()) as { values?: Array<{ id: number }> }
  const active = sprintsData.values?.[0]
  if (!active?.id) {
    const futureRes = await fetch(
      `${cfg.baseUrl}/rest/agile/1.0/board/${boardId}/sprint?state=future`,
      { headers }
    )
    if (!futureRes.ok) return
    const futureData = (await futureRes.json()) as { values?: Array<{ id: number }> }
    const next = futureData.values?.[0]
    if (!next?.id) return
    await fetch(`${cfg.baseUrl}/rest/agile/1.0/sprint/${next.id}/issue`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ issues: [issueKey] }),
    })
    return
  }
  await fetch(`${cfg.baseUrl}/rest/agile/1.0/sprint/${active.id}/issue`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ issues: [issueKey] }),
  })
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
    return NextResponse.json(
      { error: 'JIRA_BASE_URL and JIRA_API_KEY (and JIRA_EMAIL for Cloud) are required' },
      { status: 500 }
    )
  }

  let body: { title?: string; parentKey?: string; description?: string; projectKey?: string; boardId?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 })
  }

  const parentKey = typeof body.parentKey === 'string' ? body.parentKey.trim() || undefined : undefined
  const projectKeyFromBody = typeof body.projectKey === 'string' ? body.projectKey.trim() || undefined : undefined
  const boardIdFromBody = typeof body.boardId === 'string' ? body.boardId.trim() || undefined : undefined
  const descriptionText =
    typeof body.description === 'string' && body.description.trim()
      ? body.description.trim()
      : `Created from meeting.\n\nSummary: ${title}`

  let projectKey: string
  const fields: Record<string, unknown> = {
    summary: title,
    description: descriptionToAdf(descriptionText),
    issuetype: { name: 'Story' },
  }

  if (parentKey) {
    projectKey = await getProjectKeyFromIssue(parentKey, cfg)
    fields.parent = { key: parentKey }
  } else {
    const projectKeyToUse = projectKeyFromBody || cfg.projectKey
    if (!projectKeyToUse) {
      return NextResponse.json(
        { error: 'Project key required when not providing parentKey. Set JIRA_PROJECT_KEY in .env or say e.g. "in project ST" in the meeting.' },
        { status: 400 }
      )
    }
    projectKey = projectKeyToUse
  }

  fields.project = { key: projectKey }
  // Do not set assignee. Status defaults to "To Do" on create.

  const createRes = await fetch(`${cfg.baseUrl}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: getAuthHeader(cfg),
    },
    body: JSON.stringify({ fields }),
  })

  if (!createRes.ok) {
    const err = await createRes.text()
    return NextResponse.json(
      { error: `Jira create failed: ${createRes.status} ${err}` },
      { status: createRes.status >= 500 ? 500 : 400 }
    )
  }

  const createData = (await createRes.json()) as { key?: string; id?: string }
  const key = createData.key
  if (!key) {
    return NextResponse.json({ error: 'Jira returned no issue key' }, { status: 500 })
  }

  await addIssueToLatestSprint(key, cfg, boardIdFromBody)

  const link = `${cfg.baseUrl}/browse/${key}`
  return NextResponse.json({
    key,
    link,
    summary: title,
    parentKey: parentKey ?? null,
    status: 'To Do',
  })
}
