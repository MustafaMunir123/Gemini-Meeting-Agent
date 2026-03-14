/**
 * Gemini Live API client for voice-only agent (Zoom integration).
 * Sends mic audio via sendRealtimeInput({ audio }), receives and plays response audio.
 * Aligned with: https://ai.google.dev/gemini-api/docs/live
 * Input: 16-bit PCM 16kHz. Output: 16-bit PCM 24kHz.
 */
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai'

const VOICE_AGENT_SYSTEM =
  `You are a helpful voice assistant in a Zoom meeting. Keep responses concise and natural.

CRITICAL - When to respond: ONLY respond when the user EXPLICITLY says your name or a wake phrase in the same message (e.g. "Gemini", "Gemini Sidekick", "Hey Gemini", "Sidekick", "assistant", "bot"). Follow-ups are NOT exceptions: even continuations like "What about X?" or "And the second one?" require them to say your name (e.g. "Gemini") in that same message—otherwise stay silent. Every message requires an explicit invocation.`

const LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025'
const OUTPUT_SAMPLE_RATE = 24000

export type SessionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface GeminiLiveVoiceCallbacks {
  onStatusChange?: (status: SessionStatus) => void
  onError?: (message: string) => void
  onAudioReceived?: () => void
}

export class GeminiLiveVoiceClient {
  private apiKey: string
  private session: Awaited<ReturnType<GoogleGenAI['live']['connect']>> | null = null
  private audioContext: AudioContext | null = null
  private callbacks: GeminiLiveVoiceCallbacks
  private audioQueue: ArrayBuffer[] = []
  private playing = false
  private closingIntentional = false

  constructor(apiKey: string, callbacks: GeminiLiveVoiceCallbacks = {}) {
    this.apiKey = apiKey
    this.callbacks = callbacks
  }

  async connect(): Promise<void> {
    this.closingIntentional = false
    this.callbacks.onStatusChange?.('connecting')
    if (!this.audioContext) {
      this.audioContext = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE })
      await this.audioContext.resume().catch(() => {})
    }
    try {
      const ai = new GoogleGenAI({ apiKey: this.apiKey })
      this.session = await ai.live.connect({
        model: LIVE_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: VOICE_AGENT_SYSTEM,
        },
        callbacks: {
          onopen: () => {
            this.callbacks.onStatusChange?.('connected')
          },
          onmessage: (e: LiveServerMessage) => this.handleMessage(e),
          onerror: (e: ErrorEvent) => {
            this.callbacks.onStatusChange?.('error')
            this.callbacks.onError?.(e?.message ?? 'Connection error')
          },
          onclose: (e: CloseEvent) => {
            this.callbacks.onStatusChange?.('disconnected')
            if (!this.closingIntentional && (e?.code || e?.reason)) {
              this.callbacks.onError?.(`Connection closed: ${[e.code, e.reason].filter(Boolean).join(' — ')}`)
            }
          },
        },
      })
    } catch (err) {
      this.callbacks.onStatusChange?.('error')
      const message = err instanceof Error ? err.message : String(err)
      this.callbacks.onError?.(message)
      throw err
    }
  }

  private handleMessage(e: LiveServerMessage): void {
    try {
      if (e.serverContent?.interrupted) {
        this.audioQueue.length = 0
        return
      }
      const parts = e.serverContent?.modelTurn?.parts
      if (!Array.isArray(parts)) return
      for (const part of parts) {
        if (part?.inlineData?.data) {
          const binary = this.base64ToArrayBuffer(part.inlineData.data)
          if (binary) {
            this.audioQueue.push(binary)
            this.callbacks.onAudioReceived?.()
          }
        }
      }
      this.drainAudioQueue()
    } catch {
      // ignore parse errors
    }
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer | null {
    try {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes.buffer
    } catch {
      return null
    }
  }

  private drainAudioQueue(): void {
    if (this.playing || this.audioQueue.length === 0) return
    this.playing = true
    this.playNextChunk()
  }

  private playNextChunk(): void {
    if (this.audioQueue.length === 0) {
      this.playing = false
      return
    }
    const chunk = this.audioQueue.shift()!
    const ctx = this.audioContext
    if (!ctx) {
      this.playing = false
      return
    }
    ctx.resume().then(() => {
      this.decodeAndPlay(chunk, ctx).then(() => this.playNextChunk()).catch(() => this.playNextChunk())
    }).catch(() => this.playNextChunk())
  }

  private async decodeAndPlay(arrayBuffer: ArrayBuffer, ctx: AudioContext): Promise<void> {
    if (arrayBuffer.byteLength < 2) return
    try {
      const len = Math.floor(arrayBuffer.byteLength / 2)
      const view = new DataView(arrayBuffer)
      const float32 = new Float32Array(len)
      for (let i = 0; i < len; i++) float32[i] = view.getInt16(i * 2, true) / 32768
      const audioBuffer = ctx.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE)
      audioBuffer.getChannelData(0).set(float32)
      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(ctx.destination)
      return new Promise((resolve) => {
        source.onended = () => resolve()
        source.start(0)
      })
    } catch (err) {
      console.warn('[GeminiVoice] Audio decode/play error:', err)
    }
  }

  /** Send a chunk of 16-bit PCM 16kHz audio (e.g. from mic). Blob or ArrayBuffer. */
  sendAudioChunk(audio: Blob | ArrayBuffer): void {
    if (!this.session) return
    try {
      const blob = audio instanceof Blob ? audio : new Blob([audio])
      this.session.sendRealtimeInput({ audio: blob } as Parameters<typeof this.session.sendRealtimeInput>[0])
    } catch (err) {
      this.callbacks.onError?.(err instanceof Error ? err.message : String(err))
    }
  }

  /** Call when user starts talking (PTT down). Optional: signal activity start. */
  pushToTalkStart(): void {
    if (!this.session) return
    try {
      this.session.sendRealtimeInput({ activityStart: {} })
    } catch {
      // ignore
    }
  }

  /** Call when user stops talking (PTT up). Signals end of turn so model responds. */
  pushToTalkStop(): void {
    if (!this.session) return
    try {
      this.session.sendRealtimeInput({ activityEnd: {} })
      this.session.sendRealtimeInput({ audioStreamEnd: true })
    } catch {
      // ignore
    }
  }

  disconnect(): void {
    if (this.session) {
      this.closingIntentional = true
      this.session.close()
      this.session = null
    }
    this.audioQueue.length = 0
    this.playing = false
    if (this.audioContext?.state !== 'closed') {
      this.audioContext?.close().catch(() => {})
    }
    this.audioContext = null
    this.callbacks.onStatusChange?.('disconnected')
  }

  get status(): SessionStatus {
    if (!this.session) return 'disconnected'
    return 'connected'
  }
}
