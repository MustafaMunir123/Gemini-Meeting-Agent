/**
 * Browser payload: Zoom join + mixed audio capture + WebSocket to bridge.
 * Expects window.zoomInitialData and window.initialData (injected by run.mjs before joinMeeting()).
 *
 * Like Attendee: we intercept getUserMedia and give Zoom a virtual mic (silent until we play agent PCM).
 * Agent reply audio is received from the bridge and played into this mic so the user hears it in Zoom.
 */
(function () {
  // --- VirtualMic: one shared stream we can play PCM into (agent reply → Zoom meeting) ---
  const VirtualMic = {
    _ctx: null,
    _gain: null,
    _dest: null,
    _osc: null,
    _queue: [],
    _playing: false,
    _nextTime: 0,
    getStream() {
      if (!this._dest) {
        this._ctx = new (window.AudioContext || window.webkitAudioContext)()
        this._gain = this._ctx.createGain()
        this._dest = this._ctx.createMediaStreamDestination()
        this._osc = this._ctx.createOscillator()
        this._osc.frequency.value = 0
        this._gain.gain.value = 1
        this._osc.connect(this._gain)
        this._gain.connect(this._dest)
        this._osc.start(0)
      }
      return this._dest.stream
    },
    playPCM(base64, sampleRate) {
      if (!this._ctx) this.getStream()
      try {
        const binary = atob(base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        const int16 = new Int16Array(bytes.buffer)
        const float32 = new Float32Array(int16.length)
        for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768
        const duration = float32.length / sampleRate
        this._queue.push({ data: float32, duration, sampleRate })
        if (!this._playing) this._drain()
      } catch (e) {
        console.warn('[Bot] VirtualMic playPCM error', e)
      }
    },
    _drain() {
      if (this._queue.length === 0) {
        this._playing = false
        return
      }
      this._playing = true
      const { data, duration, sampleRate } = this._queue.shift()
      const ctx = this._ctx
      if (ctx.state === 'suspended') ctx.resume()
      const now = ctx.currentTime
      if (this._nextTime < now) this._nextTime = now
      const buf = ctx.createBuffer(1, data.length, sampleRate)
      buf.getChannelData(0).set(data)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(this._gain)
      src.start(this._nextTime)
      this._nextTime += duration
      const ms = Math.max(0, (this._nextTime - ctx.currentTime) * 1000 * 0.8)
      setTimeout(() => this._drain(), ms)
    },
  }
  window.virtualMic = VirtualMic

  // --- Intercept getUserMedia so Zoom gets our virtual mic (we can play agent audio into it) ---
  if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
    const _originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async function (constraints) {
      const needAudio = !!(constraints && constraints.audio !== false && constraints.audio != null)
      const needVideo = !!(constraints && constraints.video !== false && constraints.video != null)
      if (!needAudio && !needVideo) return _originalGetUserMedia(constraints)

      let originalStream = null
      try {
        originalStream = await _originalGetUserMedia(constraints)
        if (originalStream && typeof originalStream.getTracks === 'function') {
          originalStream.getTracks().forEach((t) => t.stop())
        }
      } catch (e) {
        console.warn('[Bot] getUserMedia (for permission) failed', e)
      }

      const stream = new MediaStream()
      if (needAudio) {
        const track = VirtualMic.getStream().getAudioTracks()[0]
        if (track) stream.addTrack(track.clone())
      }
      if (needVideo) {
        const canvas = document.createElement('canvas')
        canvas.width = 640
        canvas.height = 480
        const ctx2d = canvas.getContext('2d')
        if (ctx2d) {
          ctx2d.fillStyle = 'black'
          ctx2d.fillRect(0, 0, canvas.width, canvas.height)
        }
        const videoStream = canvas.captureStream(1)
        const videoTrack = videoStream.getVideoTracks()[0]
        if (videoTrack) stream.addTrack(videoTrack)
      }
      return stream
    }
  }

  function zoom() {
    return window.zoomInitialData || {}
  }
  function initial() {
    return window.initialData || {}
  }
  const leaveUrl = 'https://zoom.us'
  let userEnteredMeeting = false
  let recordingPermissionGranted = false
  let madeInitialRequestForRecordingPermission = false

  window.userHasEnteredMeeting = function () {
    return userEnteredMeeting
  }

  function closeRequestPermissionModal() {
    try {
      const modals = document.querySelectorAll('div.zm-modal, div.zm-modal-legacy')
      for (const modal of modals) {
        const titleDiv = modal.querySelector('div.zm-modal-body-title')
        if (titleDiv && titleDiv.innerText.includes('Permission needed from Meeting Host')) {
          const buttons = modal.querySelectorAll('button')
          for (const button of buttons) {
            if (button.innerText.toLowerCase() === 'close') {
              button.click()
              return
            }
          }
          return
        }
      }
    } catch (e) {
      console.warn('[Bot] closeRequestPermissionModal', e)
    }
  }

  function onRecordingPermissionGranted() {
    recordingPermissionGranted = true
    if (window.ws && typeof window.ws.sendJson === 'function') {
      window.ws.sendJson({ type: 'RecordingPermissionChange', change: 'granted' })
    }
  }

  // Unmute the bot's mic in Zoom UI so meeting audio can be captured. Same as Attendee zoom_web_chromedriver_payload.js
  function turnOnMic() {
    const labels = ['unmute my microphone', 'Unmute microphone', 'Unmute']
    for (const label of labels) {
      const btn = document.querySelector(`button[aria-label="${label}"]`) || document.querySelector(`div[aria-label="${label}"]`)
      if (btn) {
        console.log('[Bot] Clicking unmute (aria-label: ' + label + ')')
        btn.click()
        return true
      }
    }
    console.warn('[Bot] Unmute button not found (tried: ' + labels.join(', ') + ')')
    return false
  }
  window.turnOnMic = turnOnMic
  // Retry unmute a few times in case Zoom UI isn't ready yet (e.g. right after recording starts).
  window.ensureMicOn = function ensureMicOn() {
    let tried = 0
    const t = setInterval(() => {
      if (turnOnMic() || tried >= 5) clearInterval(t)
      tried += 1
    }, 1500)
  }

  function tryStartRecording() {
    if (recordingPermissionGranted) return true
    if (typeof ZoomMtg === 'undefined' || !ZoomMtg.mediaCapture) return false
    let done = false
    ZoomMtg.mediaCapture({
      record: 'start',
      success: () => {
        if (done) return
        done = true
        onRecordingPermissionGranted()
      },
      error: () => {},
    })
    return done
  }

  function askForMediaCapturePermission() {
    madeInitialRequestForRecordingPermission = true
    // Wait 1s before asking (Zoom SDK timing). See Attendee zoom_web_chromedriver_page.js
    setTimeout(() => {
      if (typeof ZoomMtg === 'undefined' || !ZoomMtg.mediaCapture) {
        console.warn('[Bot] ZoomMtg.mediaCapture not available')
        onRecordingPermissionGranted()
        return
      }
      ZoomMtg.mediaCapture({
        record: 'start',
        success: () => {
          onRecordingPermissionGranted()
        },
        error: (err) => {
          console.warn('[Bot] mediaCapture start error (will request permission and retry)', err)
          setTimeout(() => closeRequestPermissionModal(), 500)
          if (ZoomMtg.mediaCapturePermission) {
            ZoomMtg.mediaCapturePermission({
              operate: 'request',
              success: () => {
                // Host may have granted; try start again
                setTimeout(() => tryStartRecording(), 500)
              },
              error: (e) => console.warn('[Bot] mediaCapturePermission error', e),
            })
          }
          // When user approves in Zoom, our success is not always called. Retry mediaCapture start until granted.
          let retries = 0
          const maxRetries = 40
          const retryInterval = setInterval(() => {
            if (recordingPermissionGranted || retries >= maxRetries) {
              clearInterval(retryInterval)
              return
            }
            retries += 1
            ZoomMtg.mediaCapture({
              record: 'start',
              success: () => {
                if (!recordingPermissionGranted) onRecordingPermissionGranted()
                clearInterval(retryInterval)
              },
              error: () => {},
            })
          }, 3000)
        },
      })
    }, 1000)
  }
  window.askForMediaCapturePermission = askForMediaCapturePermission

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
      this.ws.onmessage = (event) => {
        let raw
        if (typeof event.data === 'string') {
          raw = event.data
        } else if (event.data instanceof ArrayBuffer) {
          raw = new TextDecoder().decode(event.data)
        } else {
          return
        }
        try {
          const msg = JSON.parse(raw)
          if (msg.trigger === 'realtime_audio.bot_output' && msg.data?.chunk && window.virtualMic) {
            window.virtualMic.playPCM(msg.data.chunk, msg.data.sample_rate || 24000)
          }
          if (msg.trigger === 'send_chat' && msg.data?.message && typeof ZoomMtg !== 'undefined' && ZoomMtg.sendChat) {
            const text = typeof msg.data.message === 'string' ? msg.data.message : JSON.stringify(msg.data.message)
            ZoomMtg.sendChat({
              message: text,
              userId: 0,
              success: () => console.log('[Bot] Chat sent to meeting'),
              error: (e) => console.warn('[Bot] sendChat error', e),
            })
          }
        } catch (_) {}
      }
    }
    sendJson(data) {
      if (this.ws.readyState !== WebSocket.OPEN) return
      try {
        const jsonString = JSON.stringify(data)
        const jsonBytes = new TextEncoder().encode(jsonString)
        const message = new Uint8Array(4 + jsonBytes.length)
        new DataView(message.buffer).setInt32(0, WebSocketClient.MESSAGE_TYPES.JSON, true)
        message.set(jsonBytes, 4)
        this.ws.send(message.buffer)
      } catch (err) {
        console.error('[Bot] sendJson error', err)
      }
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
      const checkInterval = setInterval(() => {
        if (window.styleManager._captureStarted) {
          clearInterval(checkInterval)
          return
        }
        window.styleManager.scheduleRetryIfNoTracks()
      }, 1000)
      setTimeout(() => clearInterval(checkInterval), 25000)
    }
  }

  // --- StyleManager: combine meeting audio streams ---
  class StyleManager {
    constructor() {
      this.meetingAudioStream = null
      this.audioStreams = []
      this.mixedAudioTrack = null
      this._captureStarted = false
      this._startRetryCount = 0
      this._maxStartRetries = 20
    }
    addAudioStream(stream) {
      this.audioStreams.push(stream)
    }
    async start() {
      if (this._captureStarted) return
      const audioElements = document.querySelectorAll('audio')
      if (!this.audioContext) this.audioContext = new AudioContext({ sampleRate: 48000 })
      const audioStreamTracks = this.audioStreams.map((s) => s.getAudioTracks()[0]).filter(Boolean)
      const audioElementTracks = Array.from(audioElements)
        .filter((el) => el.srcObject && el.srcObject.getAudioTracks && el.srcObject.getAudioTracks()[0])
        .map((el) => el.srcObject.getAudioTracks()[0])
      this.audioTracks = audioStreamTracks.concat(audioElementTracks)
      if (this.audioTracks.length === 0) {
        this._startRetryCount += 1
        if (this._startRetryCount <= this._maxStartRetries) {
          console.warn('[Bot] No audio tracks yet, retry ' + this._startRetryCount + '/' + this._maxStartRetries + ' in 2s')
          setTimeout(() => this.start(), 2000)
        }
        return
      }
      this._captureStarted = true
      console.log('[Bot] Capturing ' + this.audioTracks.length + ' audio track(s)')
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
    scheduleRetryIfNoTracks() {
      if (this._captureStarted) return
      const audioElements = document.querySelectorAll('audio')
      const hasElementTracks = Array.from(audioElements).some((el) => el.srcObject && el.srcObject.getAudioTracks && el.srcObject.getAudioTracks()[0])
      if (hasElementTracks || this.audioStreams.length > 0) this.start()
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
    window._joinStartedAt = Date.now()
    const root = document.getElementById('zmmtg-root') || document.getElementById('meetingSDKElement')
    if (root) root.style.display = 'block'
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
          error: (err) => {
            const msg = err && (err.message || err.reason || err.errorMessage || JSON.stringify(err))
            console.error('[Bot] Join error', err)
            if (window.ws && typeof window.ws.sendJson === 'function') {
              window.ws.sendJson({ type: 'JoinError', error: msg, raw: err })
            }
          },
        })
      },
      error: (err) => {
        console.error('[Bot] Init error', err)
        if (window.ws && typeof window.ws.sendJson === 'function') {
          window.ws.sendJson({ type: 'JoinError', error: 'ZoomMtg.init failed: ' + (err && (err.message || err.reason || JSON.stringify(err))) })
        }
      },
    })
  }

  window.joinMeeting = joinMeeting

  ZoomMtg.inMeetingServiceListener('onJoinSpeed', (data) => {
    if (!data) return
    const level = typeof data.level === 'number' ? data.level : parseInt(data.level, 10)
    if (Number.isNaN(level)) return
    // Level 5 = out of "waiting for host", 6 = in waiting room, 7+ = out of waiting room / joining. Accept 5+ so we proceed as soon as join progresses.
    if (level >= 5) {
      userEnteredMeeting = true
      console.log('[Bot] Entered meeting (onJoinSpeed level ' + level + ')')
    }
  })
  // Fallback: if onJoinSpeed never fires, consider in meeting after 12s so we still ask for permission.
  window._joinStartedAt = 0
  setInterval(() => {
    if (userEnteredMeeting || !window._joinStartedAt) return
    if (Date.now() - window._joinStartedAt > 12000) {
      userEnteredMeeting = true
      console.log('[Bot] Entered meeting (fallback after 12s)')
    }
  }, 2000)

  ZoomMtg.inMeetingServiceListener('onMeetingStatus', (data) => {
    if (data && data.meetingStatus === 3 && userEnteredMeeting) {
      console.log('[Bot] Meeting ended')
    }
  })

  if (typeof ZoomMtg.preLoadWasm === 'function') ZoomMtg.preLoadWasm()
  if (typeof ZoomMtg.prepareWebSDK === 'function') ZoomMtg.prepareWebSDK()
})()
