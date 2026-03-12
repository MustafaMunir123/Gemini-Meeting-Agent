/**
 * Browser payload: Zoom join + mixed audio capture + WebSocket to bridge.
 * Expects window.zoomInitialData and window.initialData (injected by run.mjs before joinMeeting()).
 */
(function () {
  function zoom() {
    return window.zoomInitialData || {}
  }
  function initial() {
    return window.initialData || {}
  }
  const leaveUrl = 'https://zoom.us'
  let userEnteredMeeting = false

  window.userHasEnteredMeeting = function () {
    return userEnteredMeeting
  }

  // --- WebSocket client to bridge (Node) ---
  class WebSocketClient {
    static MESSAGE_TYPES = { JSON: 1, AUDIO: 3 }
    constructor() {
      const port = (window.initialData && window.initialData.websocketPort) || 8765
      this.ws = new WebSocket('ws://localhost:' + port)
      this.ws.binaryType = 'arraybuffer'
      this.mediaSendingEnabled = false
      this.ws.onopen = () => console.log('[Bot] WebSocket connected to bridge')
      this.ws.onerror = (e) => console.error('[Bot] WebSocket error', e)
      this.ws.onclose = () => console.log('[Bot] WebSocket closed')
    }
    sendMixedAudio(timestamp, audioData) {
      if (this.ws.readyState !== WebSocket.OPEN || !this.mediaSendingEnabled) return
      try {
        const message = new Uint8Array(4 + audioData.buffer.byteLength)
        new DataView(message.buffer).setInt32(0, WebSocketClient.MESSAGE_TYPES.AUDIO, true)
        message.set(new Uint8Array(audioData.buffer), 4)
        this.ws.send(message.buffer)
      } catch (err) {
        console.error('[Bot] sendMixedAudio error', err)
      }
    }
    async enableMediaSending() {
      ensureWs()
      this.mediaSendingEnabled = true
      await window.styleManager.start()
    }
  }

  // --- StyleManager: combine meeting audio streams ---
  class StyleManager {
    constructor() {
      this.meetingAudioStream = null
      this.audioStreams = []
      this.mixedAudioTrack = null
    }
    addAudioStream(stream) {
      this.audioStreams.push(stream)
    }
    async start() {
      const audioElements = document.querySelectorAll('audio')
      this.audioContext = new AudioContext({ sampleRate: 48000 })
      const audioStreamTracks = this.audioStreams.map((s) => s.getAudioTracks()[0]).filter(Boolean)
      const audioElementTracks = Array.from(audioElements)
        .filter((el) => el.srcObject && el.srcObject.getAudioTracks && el.srcObject.getAudioTracks()[0])
        .map((el) => el.srcObject.getAudioTracks()[0])
      this.audioTracks = audioStreamTracks.concat(audioElementTracks)
      if (this.audioTracks.length === 0) {
        console.warn('[Bot] No audio tracks yet')
        return
      }
      this.audioSources = this.audioTracks.map((track) => {
        return this.audioContext.createMediaStreamSource(new MediaStream([track]))
      })
      const destination = this.audioContext.createMediaStreamDestination()
      this.audioSources.forEach((src) => src.connect(destination))
      this.meetingAudioStream = destination.stream
      this.mixedAudioTrack = this.meetingAudioStream.getAudioTracks()[0] || null
      if ((window.initialData && window.initialData.sendMixedAudio) && this.mixedAudioTrack) {
        this.processMixedAudioTrack()
      }
    }
    getMeetingAudioStream() {
      return this.meetingAudioStream
    }
    async processMixedAudioTrack() {
      if (!this.mixedAudioTrack || !window.MediaStreamTrackProcessor) {
        console.warn('[Bot] MediaStreamTrackProcessor not available')
        return
      }
      try {
        const processor = new MediaStreamTrackProcessor({ track: this.mixedAudioTrack })
        const generator = new MediaStreamTrackGenerator({ kind: 'audio' })
        const transformStream = new TransformStream({
          transform(frame, controller) {
            if (!frame) return
            try {
              if (controller.desiredSize === null) {
                frame.close()
                return
              }
              const numChannels = frame.numberOfChannels
              const numSamples = frame.numberOfFrames
              const audioData = new Float32Array(numSamples)
              if (numChannels > 1) {
                const channelData = new Float32Array(numSamples)
                for (let ch = 0; ch < numChannels; ch++) {
                  frame.copyTo(channelData, { planeIndex: ch })
                  for (let i = 0; i < numSamples; i++) audioData[i] += channelData[i]
                }
                for (let i = 0; i < numSamples; i++) audioData[i] /= numChannels
              } else {
                frame.copyTo(audioData, { planeIndex: 0 })
              }
              window.ws.sendMixedAudio(performance.now(), audioData)
              controller.enqueue(frame)
            } catch (e) {
              console.error('[Bot] Mixed audio frame error', e)
              frame.close()
            }
          },
        })
        await processor.readable.pipeThrough(transformStream).pipeTo(generator.writable).catch((e) => {
          if (e.name !== 'AbortError') console.error('[Bot] Mixed audio pipeline', e)
        })
      } catch (e) {
        console.error('[Bot] processMixedAudioTrack', e)
      }
    }
  }

  // --- Intercept AudioNode.connect so we capture Zoom's playback ---
  const origConnect = AudioNode.prototype.connect
  AudioNode.prototype.connect = function (target, ...rest) {
    if (target instanceof AudioDestinationNode && target !== window.botOutputManager?.getAudioContextDestination?.()) {
      const ctx = this.context
      if (!ctx.__captureTee) {
        try {
          const tee = ctx.createGain()
          const tap = ctx.createMediaStreamDestination()
          origConnect.call(tee, ctx.destination)
          origConnect.call(tee, tap)
          ctx.__captureTee = { tee, tap }
          if (tap.stream) window.styleManager.addAudioStream(tap.stream)
        } catch (e) {
          console.error('[Bot] Audio intercept error', e)
        }
      }
      return origConnect.call(this, ctx.__captureTee.tee, ...rest)
    }
    return origConnect.call(this, target, ...rest)
  }

  window.styleManager = new StyleManager()
  function ensureWs() {
    if (!window.ws) window.ws = new WebSocketClient()
    return window.ws
  }

  // --- Zoom join ---
  function joinMeeting() {
    ensureWs()
    const z = zoom()
    const sdkKey = z.sdkKey || ''
    const meetingNumber = z.meetingNumber || ''
    const passWord = z.meetingPassword || ''
    const userName = (initial().botName) || 'Voice Agent'
    const signature = z.signature
    if (!signature || !sdkKey || !meetingNumber) {
      console.error('[Bot] Missing zoomInitialData (signature, sdkKey, meetingNumber)')
      return
    }
    document.getElementById('meetingSDKElement').style.display = 'block'
    ZoomMtg.init({
      leaveUrl,
      patchJsMedia: true,
      leaveOnPageUnload: true,
      disableZoomLogo: true,
      disablePreview: true,
      enableWaitingRoomPreview: false,
      defaultView: 'speaker',
      success: () => {
        ZoomMtg.join({
          signature,
          sdkKey,
          meetingNumber,
          passWord,
          userName,
          userEmail: '',
          tk: z.registrantToken || '',
          recordingToken: z.joinToken || z.appPrivilegeToken || '',
          obfToken: z.onBehalfToken || '',
          zak: z.zakToken || '',
          success: () => console.log('[Bot] Join success'),
          error: (err) => console.error('[Bot] Join error', err),
        })
      },
      error: (err) => console.error('[Bot] Init error', err),
    })
  }

  window.joinMeeting = joinMeeting

  ZoomMtg.inMeetingServiceListener('onJoinSpeed', (data) => {
    if (data && data.level === 13) {
      userEnteredMeeting = true
      console.log('[Bot] Entered meeting (audio active)')
    }
  })

  ZoomMtg.inMeetingServiceListener('onMeetingStatus', (data) => {
    if (data && data.meetingStatus === 3 && userEnteredMeeting) {
      console.log('[Bot] Meeting ended')
    }
  })

  if (typeof ZoomMtg.preLoadWasm === 'function') ZoomMtg.preLoadWasm()
  if (typeof ZoomMtg.prepareWebSDK === 'function') ZoomMtg.prepareWebSDK()
})()
