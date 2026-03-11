/**
 * WebSocket server: Attendee sends meeting audio → we forward to Gemini Live;
 * Gemini response audio → we send back to Attendee (bot speaks in meeting).
 * When someone asks to "check in drive" or similar, the search_drive tool runs and
 * results are spoken and posted to meeting chat.
 * Run: node scripts/voice-ws-server.mjs
 * Then pass wss://YOUR_HOST/ (e.g. ngrok) as the audio WebSocket URL when launching the bot.
 */
import { WebSocketServer } from 'ws'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const dotenv = require('dotenv')
dotenv.config()

const PORT = Number(process.env.VOICE_WS_PORT) || 3001
const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY || process.env.GEMINI_API_KEY
const driveSearchBaseUrl = process.env.DRIVE_SEARCH_API_URL || 'http://localhost:3000'
const driveSearchSecret = process.env.DRIVE_SEARCH_SECRET || ''
const attendeeBase = process.env.ATTENDEE_API_BASE_URL || ''
const attendeeToken = process.env.ATTENDEE_API_KEY || ''

if (!apiKey) {
  console.error('Set NEXT_PUBLIC_GEMINI_API_KEY or GEMINI_API_KEY in .env')
  process.exit(1)
}

const searchDriveTool = {
  functionDeclarations: [
    {
      name: 'search_drive',
      description: 'Search the shared Google Drive folder for documents related to the user\'s question. Use when someone asks to check drive, find documents about a topic, or anything related to files in Drive.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search question or topic (e.g. "documents about Q4 budget", "anything related to onboarding")',
          },
        },
        required: ['query'],
      },
    },
  ],
}

async function callDriveSearch(query) {
  const headers = { 'Content-Type': 'application/json' }
  if (driveSearchSecret) headers['x-drive-search-secret'] = driveSearchSecret
  const res = await fetch(`${driveSearchBaseUrl}/api/drive/search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

async function sendMeetingChat(botId, message) {
  if (!botId || !attendeeBase || !attendeeToken) return
  try {
    await fetch(`${attendeeBase.replace(/\/$/, '')}/api/v1/bots/${botId}/send_chat_message`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${attendeeToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to: 'everyone', message }),
    })
  } catch (err) {
    console.error('[Voice WS] Send chat failed:', err?.message ?? err)
  }
}

// Dynamic import for ESM
const { GoogleGenAI, Modality } = await import('@google/genai')

const wss = new WebSocketServer({ port: PORT })
console.log(`Voice WebSocket server listening on ws://localhost:${PORT}`)

let audioFromAttendeeCount = 0
let audioToAttendeeCount = 0

wss.on('connection', async (attendeeWs) => {
  console.log('[Voice WS] Attendee connected')
  audioFromAttendeeCount = 0
  audioToAttendeeCount = 0
  let geminiSession = null
  let currentBotId = null

  try {
    const ai = new GoogleGenAI({ apiKey })
    geminiSession = await ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: 'You are a helpful voice assistant in a Zoom meeting. Keep responses concise and natural. When someone asks to check Drive, find documents about something, or anything like "do we have anything in drive about X", use the search_drive tool with their question. After you get the result, say the short answer out loud and mention the link if one was found (e.g. "I found something relevant: [brief summary]. Here\'s the link: [link]."). The tool may also post the link and details to the meeting chat when available.',
        tools: [searchDriveTool],
      },
      callbacks: {
        onopen: () => console.log('[Voice WS] Gemini Live connected'),
        onmessage: async (e) => {
          try {
            const parts = e.serverContent?.modelTurn?.parts
            if (Array.isArray(parts)) {
              for (const part of parts) {
                if (part?.functionCall) {
                  const { id, name, args } = part.functionCall
                  if (name === 'search_drive' && args?.query && geminiSession) {
                    const query = String(args.query).trim()
                    console.log('[Voice WS] Tool search_drive:', query)
                    let result
                    try {
                      result = await callDriveSearch(query)
                    } catch (err) {
                      result = { answer: 'Drive search failed. ' + (err?.message || 'Please try again.'), link: '', details: '' }
                    }
                    geminiSession.sendToolResponse({
                      functionResponses: [{
                        id,
                        name: 'search_drive',
                        response: result,
                      }],
                    })
                    if (result.details && currentBotId) {
                      await sendMeetingChat(currentBotId, result.details)
                    }
                  }
                  continue
                }
                if (part?.inlineData?.data) {
                  const base64 = part.inlineData.data
                  attendeeWs.send(JSON.stringify({
                    trigger: 'realtime_audio.bot_output',
                    data: { chunk: base64, sample_rate: 24000 },
                  }))
                  audioToAttendeeCount++
                  if (audioToAttendeeCount <= 3 || audioToAttendeeCount % 20 === 0) {
                    console.log('[Voice WS] Sent audio to meeting:', audioToAttendeeCount)
                  }
                }
              }
            }
          } catch (err) {
            console.error('[Voice WS] Gemini onmessage error:', err)
          }
        },
        onerror: (err) => console.error('[Voice WS] Gemini error:', err?.message ?? err),
        onclose: (e) => console.log('[Voice WS] Gemini closed', e?.code, e?.reason),
      },
    })
  } catch (err) {
    console.error('[Voice WS] Failed to connect to Gemini:', err)
    attendeeWs.close()
    return
  }

  attendeeWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.bot_id) currentBotId = msg.bot_id
      if (msg.data?.bot_id) currentBotId = msg.data.bot_id
      if (msg.trigger === 'realtime_audio.mixed' && msg.data?.chunk && geminiSession) {
        const pcmBase64 = msg.data.chunk
        geminiSession.sendRealtimeInput({
          audio: { data: pcmBase64, mimeType: 'audio/pcm;rate=16000' },
        })
        audioFromAttendeeCount++
        if (audioFromAttendeeCount <= 3 || audioFromAttendeeCount % 100 === 0) {
          console.log('[Voice WS] Received meeting audio:', audioFromAttendeeCount)
        }
      }
    } catch (err) {
      console.error('[Voice WS] Attendee message error:', err)
    }
  })

  attendeeWs.on('close', () => {
    if (geminiSession) {
      try {
        geminiSession.close()
      } catch (_) {}
      geminiSession = null
    }
    console.log('[Voice WS] Attendee disconnected (received', audioFromAttendeeCount, 'audio, sent', audioToAttendeeCount, ')')
  })
})
