/**
 * Google OAuth for Drive is fully handled in this project (zoom-agent).
 * Tokens are stored in .data/google-tokens.json; Attendee is not involved.
 */
import { google } from 'googleapis'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'

const TOKEN_PATH = path.join(process.cwd(), '.data', 'google-tokens.json')

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive', // create folders/files in Drive (e.g. Meetings/, meeting minutes)
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]

export function getOAuth2Client() {
  const clientId = process.env['GOOGLE_CLIENT_ID']
  const clientSecret = process.env['GOOGLE_CLIENT_SECRET']
  if (!clientId || !clientSecret) {
    throw new Error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET')
  }
  return new google.auth.OAuth2(
    clientId,
    clientSecret,
    getRedirectUri()
  )
}

export function getRedirectUri(): string {
  const base =
    process.env['NEXTAUTH_URL'] ||
    (process.env['APP_URL'] ? String(process.env['APP_URL']).replace(/\/$/, '') : null) ||
    (process.env['VERCEL_URL'] ? `https://${process.env['VERCEL_URL']}` : null) ||
    'http://localhost:3000'
  return `${base}/api/auth/google/callback`
}

export function getAuthUrl(): string {
  const oauth2 = getOAuth2Client()
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  })
}

export async function loadTokens(): Promise<{ access_token: string; refresh_token?: string; expiry_date?: number } | null> {
  const dir = path.dirname(TOKEN_PATH)
  if (!existsSync(dir)) return null
  if (!existsSync(TOKEN_PATH)) return null
  try {
    const data = await readFile(TOKEN_PATH, 'utf-8')
    const parsed = JSON.parse(data) as { access_token?: string; refresh_token?: string; expiry_date?: number }
    if (parsed.access_token)
      return { access_token: parsed.access_token, refresh_token: parsed.refresh_token, expiry_date: parsed.expiry_date }
    return null
  } catch {
    return null
  }
}

export async function saveTokensFromCode(code: string): Promise<void> {
  const oauth2 = getOAuth2Client()
  const { tokens } = await oauth2.getToken(code)
  const dir = path.dirname(TOKEN_PATH)
  await mkdir(dir, { recursive: true })
  await writeFile(TOKEN_PATH, JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
  }, null, 2))
}

export async function getAuthenticatedClient(): Promise<InstanceType<typeof google.auth.OAuth2> | null> {
  const oauth2 = getOAuth2Client()
  const tokens = await loadTokens()
  if (!tokens) return null
  oauth2.setCredentials(tokens)
  return oauth2
}
