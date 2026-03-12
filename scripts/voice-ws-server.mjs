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
const jiraSearchBaseUrl = process.env.JIRA_SEARCH_API_URL || process.env.DRIVE_SEARCH_API_URL || 'http://localhost:3000'
const jiraSearchSecret = process.env.JIRA_SEARCH_SECRET || ''
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

const searchJiraTool = {
  functionDeclarations: [
    {
      name: 'search_jira',
      description: 'Search Jira tickets that match the user\'s question. Use when someone asks about Jira tickets, issues, or work items (e.g. "check Jira for X", "any tickets about Y", "what\'s the status of Z"). Read-only: only fetches and matches tickets.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search question or topic (e.g. "onboarding bugs", "tickets about payment", "issues assigned to me")',
          },
        },
        required: ['query'],
      },
    },
  ],
}

async function callDriveSearch(query) {
  console.log('[TOOL] callDriveSearch called, query:', query)
  const headers = { 'Content-Type': 'application/json' }
  if (driveSearchSecret) headers['x-drive-search-secret'] = driveSearchSecret
  const res = await fetch(`${driveSearchBaseUrl}/api/drive/search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  })
  const data = await res.json().catch(() => ({}))
  console.log('[TOOL] callDriveSearch response status:', res.status, 'body keys:', data ? Object.keys(data) : [])
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

async function callJiraSearch(query) {
  console.log('[TOOL] callJiraSearch called, query:', query)
  const headers = { 'Content-Type': 'application/json' }
  if (jiraSearchSecret) headers['x-jira-search-secret'] = jiraSearchSecret
  const res = await fetch(`${jiraSearchBaseUrl}/api/jira/search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  })
  const data = await res.json().catch(() => ({}))
  console.log('[TOOL] callJiraSearch response status:', res.status, 'body keys:', data ? Object.keys(data) : [])
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
        systemInstruction: `You are a voice assistant in a Zoom meeting. Keep replies short.

CRITICAL - Drive searches: When the user asks to check Drive, search Drive, or find documents (e.g. "check in drive for X", "anything in drive about Y"):
1. First say ONE short phrase out loud, e.g. "Let me check in Drive", "Checking Drive for that."
2. Then call the search_drive tool with their question.
3. After the tool result, speak the short answer and mention the link if provided.

CRITICAL - Jira searches: When the user asks about Jira tickets, issues, or work items (e.g. "check Jira for X", "any tickets about Y"):
1. First say ONE short phrase out loud, e.g. "Let me check Jira", "Checking Jira for that."
2. Then call the search_jira tool with their question.
3. After the tool result, speak the short answer and mention the ticket link if provided.

So the user hears you're working on it before the search runs.`,
        tools: [searchDriveTool, searchJiraTool],
        functionCallingConfig: {
          mode: 'AUTO',
          allowedFunctionNames: ['search_drive', 'search_jira'],
        },
      },
      callbacks: {
        onopen: () => console.log('[Voice WS] Gemini Live connected'),
        onmessage: async (e) => {
          try {
            // Tool calls come in e.toolCall.functionCalls (same as gemini-live reference), NOT in modelTurn.parts
            if (e.toolCall?.functionCalls?.length) {
              console.log('[TOOL] toolCall.functionCalls:', e.toolCall.functionCalls.length)
              for (const fc of e.toolCall.functionCalls) {
                console.log('[TOOL] functionCall:', fc.name, fc.id, fc.args)
                if (fc.name === 'search_drive' && geminiSession) {
                  const query = (fc.args?.query != null ? String(fc.args.query) : '').trim()
                  if (!query) {
                    console.log('[TOOL] search_drive skipped: no query in args')
                    continue
                  }
                  console.log('[TOOL] Executing search_drive, query:', query)
                  let result
                  try {
                    result = await callDriveSearch(query)
                  } catch (err) {
                    console.error('[TOOL] callDriveSearch error:', err?.message ?? err)
                    result = { answer: 'Drive search failed. ' + (err?.message || 'Please try again.'), link: '', details: '' }
                  }
                  geminiSession.sendToolResponse({
                    functionResponses: [{
                      id: fc.id,
                      name: 'search_drive',
                      response: result,
                    }],
                  })
                  console.log('[TOOL] sendToolResponse done')
                  if (result.details && currentBotId) {
                    await sendMeetingChat(currentBotId, result.details)
                  }
                } else if (fc.name === 'search_jira' && geminiSession) {
                  const query = (fc.args?.query != null ? String(fc.args.query) : '').trim()
                  if (!query) {
                    console.log('[TOOL] search_jira skipped: no query in args')
                    continue
                  }
                  console.log('[TOOL] Executing search_jira, query:', query)
                  let result
                  try {
                    result = await callJiraSearch(query)
                  } catch (err) {
                    console.error('[TOOL] callJiraSearch error:', err?.message ?? err)
                    result = { answer: 'Jira search failed. ' + (err?.message || 'Please try again.'), link: '', details: '' }
                  }
                  geminiSession.sendToolResponse({
                    functionResponses: [{
                      id: fc.id,
                      name: 'search_jira',
                      response: result,
                    }],
                  })
                  console.log('[TOOL] sendToolResponse done (jira)')
                  if (result.details && currentBotId) {
                    await sendMeetingChat(currentBotId, result.details)
                  }
                }
              }
            }
            const sc = e?.serverContent
            const parts = sc?.modelTurn?.parts
            if (Array.isArray(parts)) {
              for (const part of parts) {
                const inlineData = part?.inlineData ?? part?.inline_data
                if (inlineData?.data) {
                  const base64 = inlineData.data
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
