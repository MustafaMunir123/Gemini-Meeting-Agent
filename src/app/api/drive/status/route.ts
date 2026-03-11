import { NextResponse } from 'next/server'
import { loadTokens } from '@/lib/google-auth'

/**
 * Drive OAuth is fully handled in this project (not Attendee).
 * Tokens are stored in .data/google-tokens.json and used by /api/drive/search.
 */
export async function GET() {
  try {
    const tokens = await loadTokens()
    return NextResponse.json({ connected: !!tokens })
  } catch {
    return NextResponse.json({ connected: false })
  }
}
