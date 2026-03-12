import { NextResponse } from 'next/server'

type ChildProcess = import('child_process').ChildProcess
const g = globalThis as unknown as { __zoomBotProcess?: ChildProcess | null }

export async function POST() {
  const child = g.__zoomBotProcess
  if (!child) {
    return NextResponse.json({ ok: true, message: 'No zoom bot process was running.' })
  }
  try {
    child.kill('SIGTERM')
  } catch {
    // ignore
  }
  g.__zoomBotProcess = null
  return NextResponse.json({ ok: true, message: 'Zoom bot process stopped.' })
}
