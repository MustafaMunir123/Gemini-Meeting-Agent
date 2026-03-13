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

const writeToChatTool = {
  functionDeclarations: [
    {
      name: 'write_to_chat',
      description: 'Write a message to the Zoom meeting chat so all participants can see it. Use when the user asks to: write something in chat; put a summary or meeting minutes in the chat box; post meeting notes to chat; "add this to the chat"; or provide any text to the meeting chat. You can post a structured meeting summary (summary, key points, action items) to chat—this is allowed and preferred when they ask for minutes or summary in chat.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'The exact text to post to the meeting chat.',
          },
        },
        required: ['message'],
      },
    },
  ],
}

const createMeetingMinutesTool = {
  functionDeclarations: [
    {
      name: 'create_meeting_minutes',
      description: 'Save meeting minutes as a file to Google Drive in the Meetings/ folder. The file name is always auto-generated: current date (YYYY-MM-DD) plus a 6-digit ID (e.g. 2025-03-10_482917.txt). Do not ask the user for a file name—the system prefixes with the current date automatically. Use only when the user asks to save/upload meeting minutes to Drive. Compose from the conversation: summary, key points, action items.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'Brief summary of the meeting or discussion (required).',
          },
          keyPoints: {
            type: 'string',
            description: 'Optional. Key discussion points, one per line or as bullet text.',
          },
          actionItems: {
            type: 'string',
            description: 'Optional. Action items or follow-ups from the meeting.',
          },
          additionalNotes: {
            type: 'string',
            description: 'Optional. Any other notes to include.',
          },
        },
        required: ['summary'],
      },
    },
  ],
}

const createJiraTool = {
  functionDeclarations: [
    {
      name: 'create_jira',
      description: 'Create a new Jira ticket (Story or Sub-task). Use when the user asks to create a Jira ticket, story, or task. The user can say in chat: project key (e.g. "in project ST"), board ID (e.g. "add to board 42"), parent ticket (e.g. "under ST-5"). Before calling: if the user did not give a clear title, ask for it. Do not set or ask for assignee.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The ticket title/summary (required).',
          },
          parentKey: {
            type: 'string',
            description: 'Optional. Parent issue key (e.g. ST-5) to create a sub-task under it. Omit to create a top-level Story.',
          },
          projectKey: {
            type: 'string',
            description: 'Optional. Jira project key (e.g. ST, PROJ) when creating a top-level Story. Use if the user says "in project X" or "project key ST".',
          },
          boardId: {
            type: 'string',
            description: 'Optional. Jira board ID (number as string, e.g. "42") to add the new issue to that board\'s latest sprint. Use if the user says "board 42" or "add to board X".',
          },
          description: {
            type: 'string',
            description: 'Optional. Detailed description for the ticket. If not provided, a short default description will be used.',
          },
        },
        required: ['title'],
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

async function callJiraCreate(title, parentKey, description, projectKey, boardId) {
  console.log('[TOOL] callJiraCreate called, title:', title, 'parentKey:', parentKey || '(none)', 'projectKey:', projectKey || '(env)', 'boardId:', boardId || '(env)')
  const headers = { 'Content-Type': 'application/json' }
  if (jiraSearchSecret) headers['x-jira-search-secret'] = jiraSearchSecret
  const body = { title }
  if (parentKey) body.parentKey = parentKey
  if (description) body.description = description
  if (projectKey) body.projectKey = projectKey
  if (boardId) body.boardId = boardId
  const res = await fetch(`${jiraSearchBaseUrl}/api/jira/create`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  console.log('[TOOL] callJiraCreate response status:', res.status, 'key:', data?.key)
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}

async function callCreateMeetingMinutes(summary, keyPoints, actionItems, additionalNotes) {
  console.log('[TOOL] callCreateMeetingMinutes called')
  const headers = { 'Content-Type': 'application/json' }
  if (driveSearchSecret) headers['x-drive-search-secret'] = driveSearchSecret
  const body = { summary }
  if (keyPoints) body.keyPoints = keyPoints
  if (actionItems) body.actionItems = actionItems
  if (additionalNotes) body.additionalNotes = additionalNotes
  const res = await fetch(`${driveSearchBaseUrl}/api/drive/meeting-minutes`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  console.log('[TOOL] callCreateMeetingMinutes response status:', res.status, 'name:', data?.name)
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
    // Use 09-2025 for stability; 12-2025 often closes with 1008 "Operation is not implemented" (see googleapis/js-genai#1236)
    geminiSession = await ai.live.connect({
      model: process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-09-2025',
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: `You are a voice assistant in a Zoom meeting. Keep replies short.

CRITICAL - When to respond:
(1) Starting a conversation: Only START responding when someone clearly invokes you by name or phrase (e.g. "Hey Gemini", "Gemini", "assistant", "bot") with or before their question. Do NOT respond to side conversations or when no one has addressed you.
(2) During an active exchange: Once the user has invoked you and you are in a back-and-forth with them, treat their follow-up speech as still directed at you. Do NOT require them to say your name again for every message—continue responding to their follow-ups (e.g. "and also check Jira", "write that in chat", "what about last week?") until the exchange is clearly over.
(3) Ending the exchange: Consider the exchange over and go back to waiting for your name when: they say thanks/goodbye and stop, they clearly address someone else (e.g. "John, what do you think?"), or there is a long pause and then other people are talking. Then require invocation again before responding.
If in doubt whether new speech is for you or for others, stay silent. It is better to miss one request than to interrupt a human conversation.

CRITICAL - Drive searches: When the user asks to check Drive, search Drive, or find documents (e.g. "check in drive for X", "anything in drive about Y"):
1. First say ONE short phrase out loud, e.g. "Let me check in Drive", "Checking Drive for that."
2. Then call the search_drive tool with their question.
3. After the tool result, speak the short answer and mention the link if provided.

CRITICAL - Jira searches: When the user asks about Jira tickets, issues, or work items (e.g. "check Jira for X", "any tickets about Y"):
1. First say ONE short phrase out loud, e.g. "Let me check Jira", "Checking Jira for that."
2. Then call the search_jira tool with their question.
3. After the tool result, speak the short answer and mention the ticket link if provided.

CRITICAL - Creating Jira tickets (only here: ask for missing context): When the user asks to create a Jira ticket, story, or task:
1. You MUST have a clear title from the user before calling create_jira. If they did not give a title (e.g. "create a Jira ticket" with no details), ask: "What should the title be?" and wait for their answer. Do not invent or guess a title.
2. Optionally ask for a parent ticket key (e.g. "Under which ticket?") and for a short description if useful.
3. Do NOT ask for or set assignee.
4. Call create_jira with title (required). If the user said a project key (e.g. "in project ST") or board ID (e.g. "add to board 42") or parent ticket, pass projectKey, boardId, or parentKey. The ticket will be created as a Story with status To Do and optionally added to the given board's latest sprint.

CRITICAL - Meeting summary / minutes (two options; follow what the user asked for):
(1) Summary or minutes IN THE CHAT: If the user asks for meeting minutes in the chat, a summary in the chat box, or to put the summary in chat, use write_to_chat. Compose a structured summary (what was discussed, key points, action items) and call write_to_chat with that message. Do not refuse or say you can only upload to Drive—posting to chat is allowed.
(2) Save minutes TO DRIVE: If the user asks to save meeting minutes to Drive, upload them to Google Drive, or put them on Drive, use create_meeting_minutes. The file name is always auto-generated (current date + 6-digit ID); do not ask the user for a file name. Say a short phrase (e.g. "Saving meeting minutes to Drive"), then call the tool. After the result, share the Drive link. The user may ask for chat first and later ask to upload to Drive—do both as requested.

So the user hears you're working on it before the search runs.`,
        tools: [searchDriveTool, searchJiraTool, writeToChatTool, createMeetingMinutesTool, createJiraTool],
        functionCallingConfig: {
          mode: 'AUTO',
          allowedFunctionNames: ['search_drive', 'search_jira', 'write_to_chat', 'create_meeting_minutes', 'create_jira'],
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
                  if (result.details) {
                    if (currentBotId) await sendMeetingChat(currentBotId, result.details)
                    attendeeWs.send(JSON.stringify({ trigger: 'send_chat', data: { message: result.details } }))
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
                  if (result.details) {
                    if (currentBotId) await sendMeetingChat(currentBotId, result.details)
                    attendeeWs.send(JSON.stringify({ trigger: 'send_chat', data: { message: result.details } }))
                  }
                } else if (fc.name === 'write_to_chat' && geminiSession) {
                  const message = (fc.args?.message != null ? String(fc.args.message) : '').trim()
                  if (!message) {
                    console.log('[TOOL] write_to_chat skipped: no message in args')
                    geminiSession.sendToolResponse({
                      functionResponses: [{ id: fc.id, name: 'write_to_chat', response: { success: false, error: 'No message provided' } }],
                    })
                    continue
                  }
                  console.log('[TOOL] write_to_chat:', message.slice(0, 80) + (message.length > 80 ? '...' : ''))
                  if (currentBotId) await sendMeetingChat(currentBotId, message)
                  attendeeWs.send(JSON.stringify({ trigger: 'send_chat', data: { message } }))
                  geminiSession.sendToolResponse({
                    functionResponses: [{ id: fc.id, name: 'write_to_chat', response: { success: true, message: 'Written to meeting chat' } }],
                  })
                  console.log('[TOOL] write_to_chat done')
                } else if (fc.name === 'create_meeting_minutes' && geminiSession) {
                  const summary = (fc.args?.summary != null ? String(fc.args.summary) : '').trim()
                  if (!summary) {
                    geminiSession.sendToolResponse({
                      functionResponses: [{ id: fc.id, name: 'create_meeting_minutes', response: { success: false, error: 'Summary is required for meeting minutes.' } }],
                    })
                    continue
                  }
                  const keyPoints = (fc.args?.keyPoints != null ? String(fc.args.keyPoints) : '').trim() || undefined
                  const actionItems = (fc.args?.actionItems != null ? String(fc.args.actionItems) : '').trim() || undefined
                  const additionalNotes = (fc.args?.additionalNotes != null ? String(fc.args.additionalNotes) : '').trim() || undefined
                  let result
                  try {
                    result = await callCreateMeetingMinutes(summary, keyPoints, actionItems, additionalNotes)
                    result = { success: true, ...result, details: `Meeting minutes saved to Drive.\nFile: ${result.name}\nLink: ${result.link}` }
                  } catch (err) {
                    console.error('[TOOL] callCreateMeetingMinutes error:', err?.message ?? err)
                    result = { success: false, error: err?.message || 'Failed to save meeting minutes to Drive.', details: '' }
                  }
                  geminiSession.sendToolResponse({
                    functionResponses: [{ id: fc.id, name: 'create_meeting_minutes', response: result }],
                  })
                  if (result.details) {
                    if (currentBotId) await sendMeetingChat(currentBotId, result.details)
                    attendeeWs.send(JSON.stringify({ trigger: 'send_chat', data: { message: result.details } }))
                  }
                  console.log('[TOOL] create_meeting_minutes done')
                } else if (fc.name === 'create_jira' && geminiSession) {
                  const title = (fc.args?.title != null ? String(fc.args.title) : '').trim()
                  if (!title) {
                    geminiSession.sendToolResponse({
                      functionResponses: [{ id: fc.id, name: 'create_jira', response: { success: false, error: 'Title is required. Ask the user for a title.' } }],
                    })
                    continue
                  }
                  const parentKey = (fc.args?.parentKey != null ? String(fc.args.parentKey) : '').trim() || undefined
                  const description = (fc.args?.description != null ? String(fc.args.description) : '').trim() || undefined
                  const projectKey = (fc.args?.projectKey != null ? String(fc.args.projectKey) : '').trim() || undefined
                  const boardId = (fc.args?.boardId != null ? String(fc.args.boardId) : '').trim() || undefined
                  let result
                  try {
                    result = await callJiraCreate(title, parentKey, description, projectKey, boardId)
                    result = { success: true, ...result, details: `Created: ${result.key} – ${result.summary}\nStatus: ${result.status}\nLink: ${result.link}` }
                  } catch (err) {
                    console.error('[TOOL] callJiraCreate error:', err?.message ?? err)
                    result = { success: false, error: err?.message || 'Failed to create Jira ticket.', details: '' }
                  }
                  geminiSession.sendToolResponse({
                    functionResponses: [{ id: fc.id, name: 'create_jira', response: result }],
                  })
                  if (result.details) {
                    if (currentBotId) await sendMeetingChat(currentBotId, result.details)
                    attendeeWs.send(JSON.stringify({ trigger: 'send_chat', data: { message: result.details } }))
                  }
                  console.log('[TOOL] create_jira done')
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
        onclose: (e) => {
          const code = e?.code
          const reason = e?.reason ?? ''
          console.log('[Voice WS] Gemini closed', code, reason)
          if (code === 1008) {
            console.warn('[Voice WS] 1008 = policy/unsupported. Try GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-09-2025 or unset GEMINI_LIVE_MODEL, then reconnect.')
          } else if (code === 1011) {
            console.warn('[Voice WS] 1011 = server inference failed (Gemini backend error). Often transient—reconnect the bot (e.g. relaunch minimal bot or rejoin meeting) to retry.')
          }
        },
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
      } catch (_) { }
      geminiSession = null
    }
    console.log('[Voice WS] Attendee disconnected (received', audioFromAttendeeCount, 'audio, sent', audioToAttendeeCount, ')')
  })
})
