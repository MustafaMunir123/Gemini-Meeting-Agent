'use client'

import { useRef, useState, useCallback } from 'react'
import ZoomVideo from '@zoom/videosdk'

const VideoQuality = (ZoomVideo as unknown as { VideoQuality?: { Video_360P: number } }).VideoQuality ?? { Video_360P: 2 }

export type ZoomClient = ReturnType<typeof ZoomVideo.createClient>

export interface VideochatProps {
  slug: string
  jwt: string
  userName?: string
  onClientReady?: (client: ZoomClient) => void
}

export default function Videochat({ slug, jwt, userName = 'User', onClientReady }: VideochatProps) {
  const [inSession, setInSession] = useState(false)
  const clientRef = useRef<ZoomClient>(ZoomVideo.createClient())
  const videoContainerRef = useRef<HTMLDivElement>(null)

  const renderVideo = useCallback(
    async (event: { action: 'Start' | 'Stop'; userId: number }) => {
      const client = clientRef.current
      if (!client || !videoContainerRef.current) return
      const mediaStream = client.getMediaStream()
      if (event.action === 'Stop') {
        const element = await mediaStream.detachVideo(event.userId)
        if (Array.isArray(element)) element.forEach((el) => el.remove())
        else if (element) element.remove()
      } else {
        const userVideo = await mediaStream.attachVideo(event.userId, VideoQuality.Video_360P)
        if (userVideo && videoContainerRef.current) {
          videoContainerRef.current.appendChild(userVideo as HTMLVideoElement)
        }
      }
    },
    []
  )

  const joinSession = useCallback(async () => {
    const client = clientRef.current
    if (!client) return
    try {
      await client.init('en-US', 'Global', { patchJsMedia: true })
      client.on('peer-video-state-change', renderVideo)
      await client.join(slug, jwt, userName)
      setInSession(true)
      const mediaStream = client.getMediaStream()
      await mediaStream.startAudio()
      await mediaStream.startVideo()
      await renderVideo({
        action: 'Start',
        userId: client.getCurrentUserInfo()?.userId ?? 0,
      })
      onClientReady?.(client)
    } catch (err) {
      console.error('Session join failed:', err)
    }
  }, [slug, jwt, userName, renderVideo, onClientReady])

  const leaveSession = useCallback(async () => {
    const client = clientRef.current
    if (!client) return
    client.off('peer-video-state-change', renderVideo)
    await client.leave()
    setInSession(false)
    if (videoContainerRef.current) {
      videoContainerRef.current.innerHTML = ''
    }
    window.location.href = '/'
  }, [renderVideo])

  return (
    <div>
      <div className="controls">
        {!inSession ? (
          <button type="button" className="btn btn-join" onClick={joinSession}>
            Join session
          </button>
        ) : (
          <button type="button" className="btn btn-leave" onClick={leaveSession}>
            Leave session
          </button>
        )}
      </div>
      {inSession && (
        <div className="video-container" ref={videoContainerRef} />
      )}
    </div>
  )
}
