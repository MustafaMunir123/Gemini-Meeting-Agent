import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'
import { getAuthenticatedClient } from '@/lib/google-auth'
import { randomInt } from 'crypto'

const getDriveFolderId = () => process.env['DRIVE_FOLDER_ID']

function getDocId(): string {
  return String(randomInt(100000, 999999))
}

function formatDate(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function buildStructuredContent(params: {
  date: string
  documentId: string
  summary: string
  keyPoints?: string
  actionItems?: string
  additionalNotes?: string
}): string {
  const lines: string[] = [
    'MEETING MINUTES',
    '================',
    '',
    `Date: ${params.date}`,
    `Document ID: ${params.documentId}`,
    '',
    '---',
    '',
    'SUMMARY',
    '--------',
    params.summary.trim(),
    '',
  ]
  if (params.keyPoints?.trim()) {
    lines.push('KEY DISCUSSION POINTS', '----------------------', '', params.keyPoints.trim(), '')
  }
  if (params.actionItems?.trim()) {
    lines.push('ACTION ITEMS', '-------------', '', params.actionItems.trim(), '')
  }
  if (params.additionalNotes?.trim()) {
    lines.push('ADDITIONAL NOTES', '----------------', '', params.additionalNotes.trim(), '')
  }
  return lines.join('\n')
}

async function getOrCreateMeetingsFolder(
  drive: ReturnType<typeof google.drive>,
  parentId: string
): Promise<string> {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)',
    pageSize: 20,
  })
  const folders = (res.data.files || []) as { id: string; name: string }[]
  const meetings = folders.find((f) => f.name === 'Meetings')
  if (meetings?.id) return meetings.id
  const createRes = await drive.files.create({
    requestBody: {
      name: 'Meetings',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
  })
  const id = createRes.data.id
  if (!id) throw new Error('Failed to create Meetings folder')
  return id
}

export async function POST(request: NextRequest) {
  const secret = process.env['DRIVE_SEARCH_SECRET']
  if (secret) {
    const header = request.headers.get('x-drive-search-secret') || request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (header !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const driveFolderId = getDriveFolderId()
  if (!driveFolderId) {
    return NextResponse.json({ error: 'DRIVE_FOLDER_ID not configured' }, { status: 500 })
  }

  let body: { summary?: string; keyPoints?: string; actionItems?: string; additionalNotes?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const summary = typeof body.summary === 'string' ? body.summary.trim() : ''
  if (!summary) {
    return NextResponse.json({ error: 'summary is required' }, { status: 400 })
  }

  const keyPoints = typeof body.keyPoints === 'string' ? body.keyPoints.trim() : undefined
  const actionItems = typeof body.actionItems === 'string' ? body.actionItems.trim() : undefined
  const additionalNotes = typeof body.additionalNotes === 'string' ? body.additionalNotes.trim() : undefined

  const auth = await getAuthenticatedClient()
  if (!auth) {
    return NextResponse.json(
      { error: 'Google Drive not connected. Visit /api/auth/google to connect.' },
      { status: 401 }
    )
  }

  try {
    const drive = google.drive({ version: 'v3', auth })
    const meetingsFolderId = await getOrCreateMeetingsFolder(drive, driveFolderId)
    const dateStr = formatDate()
    const documentId = getDocId()
    const fileName = `${dateStr}_${documentId}.txt`
    const content = buildStructuredContent({
      date: dateStr,
      documentId,
      summary,
      keyPoints,
      actionItems,
      additionalNotes,
    })

    const createRes = await drive.files.create({
      requestBody: {
        name: fileName,
        mimeType: 'text/plain',
        parents: [meetingsFolderId],
      },
      media: {
        mimeType: 'text/plain',
        body: content,
      },
    })

    const fileId = createRes.data.id
    if (!fileId) {
      return NextResponse.json({ error: 'Drive did not return file id' }, { status: 500 })
    }

    const link = `https://drive.google.com/file/d/${fileId}/view`
    return NextResponse.json({
      success: true,
      fileId,
      link,
      name: fileName,
      documentId,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to create meeting minutes'
    const is403 = message.includes('Insufficient Permission') || (e && typeof e === 'object' && (e as unknown as { code?: number }).code === 403)
    if (is403) {
      return NextResponse.json(
        {
          error: 'Google Drive permission denied. Reconnect Drive: go to your app, disconnect Google Drive, then connect again (or revoke at myaccount.google.com/permissions and reconnect) so the app can create files.',
        },
        { status: 403 }
      )
    }
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
