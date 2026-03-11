'use client'

import dynamic from 'next/dynamic'
import type { ZoomClient } from './Videochat'

const Videochat = dynamic<{
  slug: string
  jwt: string
  userName?: string
  onClientReady?: (client: ZoomClient) => void
}>(() => import('./Videochat'), { ssr: false })

export default function VideochatClientWrapper(props: {
  slug: string
  jwt: string
  userName?: string
  onClientReady?: (client: ZoomClient) => void
}) {
  return <Videochat {...props} />
}
