import { Suspense } from 'react'
import { getData } from '@/data/getToken'
import App from './App'
import Gate from './Gate'

export default async function Page() {
  let jwt: string | null = null
  if (process.env['ZOOM_SDK_KEY'] && process.env['ZOOM_SDK_SECRET']) {
    jwt = await getData('zoom-gemini-session')
  }
  return (
    <Suspense fallback={<div style={{ padding: '2rem', color: '#a1a1aa' }}>Loading…</div>}>
      <Gate>
        <App jwt={jwt} />
      </Gate>
    </Suspense>
  )
}
