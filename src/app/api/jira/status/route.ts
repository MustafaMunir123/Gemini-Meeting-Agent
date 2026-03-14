import { NextResponse } from 'next/server'

export async function GET() {
  const configured =
    !!(process.env['JIRA_BASE_URL'] ?? '').trim() &&
    !!(process.env['JIRA_API_KEY'] ?? '').trim()
  return NextResponse.json({ configured })
}
