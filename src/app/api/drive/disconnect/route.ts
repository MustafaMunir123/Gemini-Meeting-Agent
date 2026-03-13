import { NextResponse } from 'next/server'
import { unlink } from 'fs/promises'
import path from 'path'

const TOKEN_PATH = path.join(process.cwd(), '.data', 'google-tokens.json')

/**
 * Remove stored Google Drive OAuth tokens so the user can reconnect
 * with fresh scopes (e.g. after adding drive scope for meeting minutes).
 */
export async function POST() {
  try {
    await unlink(TOKEN_PATH)
    return NextResponse.json({ ok: true, message: 'Drive disconnected. Connect again to re-auth with current scopes.' })
  } catch (e) {
    if ((e as unknown as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return NextResponse.json({ ok: true, message: 'Already disconnected.' })
    }
    return NextResponse.json({ error: (e instanceof Error ? e.message : 'Failed to disconnect') }, { status: 500 })
  }
}
