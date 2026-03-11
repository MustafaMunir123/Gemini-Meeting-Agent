import { NextRequest, NextResponse } from 'next/server'
import { saveTokensFromCode } from '@/lib/google-auth'

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  if (!code) {
    return NextResponse.redirect(new URL('/?error=missing_code', request.url))
  }
  try {
    await saveTokensFromCode(code)
    return NextResponse.redirect(new URL('/?drive=connected', request.url))
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to save tokens'
    return NextResponse.redirect(new URL(`/?error=${encodeURIComponent(message)}`, request.url))
  }
}
