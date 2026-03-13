/**
 * Capture microphone and produce 16-bit PCM at 16kHz for Gemini Live API.
 * Uses ScriptProcessor (deprecated but widely supported) for simplicity.
 */
const TARGET_SAMPLE_RATE = 16000
const CHUNK_MS = 80
const TARGET_CHUNK_SAMPLES = Math.floor((TARGET_SAMPLE_RATE * CHUNK_MS) / 1000)

export interface MicCaptureCallbacks {
  onChunk: (pcmBlob: Blob) => void
  onError?: (err: string) => void
}

export class MicCapture {
  private stream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private processor: ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private resampleBuffer: number[] = []
  private callbacks: MicCaptureCallbacks
  private inputSampleRate = 48000

  constructor(callbacks: MicCaptureCallbacks) {
    this.callbacks = callbacks
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    this.audioContext = new AudioContext()
    this.inputSampleRate = this.audioContext.sampleRate
    this.source = this.audioContext.createMediaStreamSource(this.stream)
    const bufferSize = 4096
    this.processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1)
    this.resampleBuffer = []

    this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
      const input = e.inputBuffer.getChannelData(0)
      const ratio = this.inputSampleRate / TARGET_SAMPLE_RATE
      for (let i = 0; i < input.length; i++) {
        const srcIndex = i * ratio
        const idx = Math.floor(srcIndex)
        const frac = srcIndex - idx
        const next = idx + 1 < input.length ? input[idx + 1] : input[idx]
        const sample = input[idx] * (1 - frac) + next * frac
        this.resampleBuffer.push(sample)
      }
      this.flushResampleBuffer()
    }

    this.source.connect(this.processor)
    const silence = this.audioContext.createGain()
    silence.gain.value = 0
    this.processor.connect(silence)
    silence.connect(this.audioContext.destination)
  }

  private flushResampleBuffer(): void {
    while (this.resampleBuffer.length >= TARGET_CHUNK_SAMPLES) {
      const chunk = this.resampleBuffer.splice(0, TARGET_CHUNK_SAMPLES)
      const pcm = new Int16Array(chunk.length)
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]))
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      this.callbacks.onChunk(new Blob([pcm.buffer]))
    }
  }

  stop(): void {
    if (this.processor) {
      try {
        this.processor.disconnect()
      } catch {
        // already disconnected
      }
      this.processor = null
    }
    if (this.source) {
      this.source.disconnect()
      this.source = null
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop())
      this.stream = null
    }
    if (this.audioContext?.state !== 'closed') {
      this.audioContext?.close().catch(() => {})
    }
    this.audioContext = null
    this.resampleBuffer = []
  }
}
