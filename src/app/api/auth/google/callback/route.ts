import { NextRequest, NextResponse } from 'next/server'
import { saveTokensFromCode, getAppBaseUrl } from '@/lib/google-auth'

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const base = getAppBaseUrl()
  if (!code) {
    return NextResponse.redirect(`${base}/?error=missing_code`)
  }
  try {
    await saveTokensFromCode(code)
    return NextResponse.redirect(`${base}/?drive=connected`)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to save tokens'
    return NextResponse.redirect(`${base}/?error=${encodeURIComponent(message)}`)
  }
}
