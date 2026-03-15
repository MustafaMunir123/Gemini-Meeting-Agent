import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'
import { getAuthenticatedClient } from '@/lib/google-auth'
import pdfParse from 'pdf-parse'
import mammoth from 'mammoth'

// Read at runtime so Cloud Run env vars work (Next.js won't inline process.env['VAR'])
const getDriveFolderId = () => process.env['DRIVE_FOLDER_ID']
const SUPPORTED_MIMES = new Set([
  'application/pdf',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.google-apps.document',
])

type FileEntry = { id: string; name: string; mimeType: string }

async function listFilesInFolder(drive: ReturnType<typeof google.drive>, folderId: string): Promise<FileEntry[]> {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType)',
    pageSize: 100,
  })
  const files = (res.data.files || []) as FileEntry[]
  return files.filter((f) => f.id && f.name && (SUPPORTED_MIMES.has(f.mimeType || '') || (f.mimeType || '').startsWith('text/')))
}

async function downloadAsBuffer(drive: ReturnType<typeof google.drive>, fileId: string): Promise<Buffer> {
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  )
  return Buffer.from(res.data as unknown as ArrayBuffer)
}

async function exportGoogleDocAsText(drive: ReturnType<typeof google.drive>, fileId: string): Promise<string> {
  const res = await drive.files.export(
    { fileId, mimeType: 'text/plain' },
    { responseType: 'arraybuffer' }
  )
  return Buffer.from(res.data as unknown as ArrayBuffer).toString('utf-8')
}

async function extractText(drive: ReturnType<typeof google.drive>, file: FileEntry): Promise<string | null> {
  try {
    if (file.mimeType === 'application/vnd.google-apps.document') {
      return await exportGoogleDocAsText(drive, file.id)
    }
    const buf = await downloadAsBuffer(drive, file.id)
    if (file.mimeType === 'application/pdf') {
      const data = await pdfParse(buf)
      return data.text || ''
    }
    if (file.mimeType === 'text/plain' || (file.mimeType || '').startsWith('text/')) {
      return buf.toString('utf-8')
    }
    if (file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.extractRawText({ buffer: buf })
      return result.value
    }
    return null
  } catch {
    return null
  }
}

function buildDocContext(files: FileEntry[], contents: Map<string, string>): string {
  const baseUrl = 'https://drive.google.com/file/d/'
  const parts: string[] = []
  for (const f of files) {
    const text = contents.get(f.id)
    if (text && text.trim()) {
      parts.push(`[File: ${f.name}](${baseUrl}${f.id})\n\n${text.slice(0, 50000)}`)
    }
  }
  return parts.join('\n\n---\n\n')
}

async function answerWithGemini(query: string, docContext: string): Promise<{ answer: string; link: string; details: string }> {
  const apiKey = process.env['NEXT_PUBLIC_GEMINI_API_KEY'] || process.env['GEMINI_API_KEY']
  if (!apiKey) throw new Error('Missing Gemini API key')
  const prompt = `You are a meeting assistant.

User request:
"${query}"

Context documents:
${docContext || '(No document content was available.)'}

Task:
- Find the best matching document(s) for the user request.
- Prefer precision over broad summaries.

Output format:
Return JSON only (no markdown, no extra text) with exactly these keys:
- "answer": A short spoken response (1-2 sentences) suitable for voice.
- "link": Best matching document link (https://drive.google.com/...) or empty string.
- "details": A concise chat-ready summary including the link and why it matches.`

  const model = process.env['DRIVE_SEARCH_GEMINI_MODEL'] || 'gemini-2.5-flash'
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
    answer: typeof parsed.answer === 'string' ? parsed.answer : 'I couldn’t find a clear match in the documents.',
    link: typeof parsed.link === 'string' ? parsed.link : '',
    details: typeof parsed.details === 'string' ? parsed.details : '',
  }
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

  let body: { query?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const query = typeof body.query === 'string' ? body.query.trim() : ''
  if (!query) {
    return NextResponse.json({ error: 'query is required' }, { status: 400 })
  }

  const auth = await getAuthenticatedClient()
  if (!auth) {
    return NextResponse.json({ error: 'Google Drive not connected. Visit /api/auth/google to connect.' }, { status: 401 })
  }

  try {
    const drive = google.drive({ version: 'v3', auth })
    const files = await listFilesInFolder(drive, driveFolderId)
    const contents = new Map<string, string>()
    for (const file of files) {
      const text = await extractText(drive, file)
      if (text) contents.set(file.id, text)
    }
    const docContext = buildDocContext(files, contents)
    const result = await answerWithGemini(query, docContext)
    return NextResponse.json(result)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Drive search failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
