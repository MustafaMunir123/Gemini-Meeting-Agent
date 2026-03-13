/**
 * WebSocket server: meeting bot sends audio → we forward to Gemini Live;
 * Gemini response audio → we send back (bot speaks in meeting). Tools: search_drive, search_jira, write_to_chat, etc.
 * Merged mode: use attachVoiceWs(server, '/voice-ws') from server.js so one port serves both Next.js and voice WS.
 * Standalone: node scripts/voice-ws-server.mjs (listens on VOICE_WS_PORT, default 3001).
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
      description: 'Search the shared Google Drive folder for documents related to the user\'s question. Use when someone asks to check drive, find documents about a topic, or anything related to files in Drive. After the search, the system automatically posts the result details to the meeting chat; tell the user the results are in chat.',
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
      description: 'Search Jira tickets that match the user\'s question. Use when someone asks about Jira tickets, issues, or work items (e.g. "check Jira for X", "any tickets about Y", "what\'s the status of Z"). Read-only. After the search, the system automatically posts the result details to the meeting chat; tell the user the results are in chat.',
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
      description: 'Write a message to the meeting chat so all participants can see it. Use whenever the user asks to: add something to chat; put text in chat; post to chat; "add to chat"; "add that to chat"; write in chat; or share something in the chat. Include: meeting summaries or minutes, any text they want in chat, search result summaries, or your own composed message. Call this tool with the exact text to post—do not refuse. The system will send it to the meeting chat.',
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
      description: 'Save meeting minutes as a file to Google Drive in the Meetings/ folder. File name is auto-generated (date + ID). Use when the user asks to save or upload meeting minutes to Drive. Compose summary, key points, action items from the conversation—or use reasonable placeholder content if they say "assume" or "use dummy content". Do not refuse to generate example minutes.',
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
      description: 'Create a new Jira ticket (Story or Sub-task). Use when the user asks to create a Jira ticket, story, or task. The user can say: project key, board ID, parent ticket. If the user asks you to "use a dummy title", "assume a title", "make up an example", or "use placeholder text", generate a reasonable example (e.g. "Demo: Implement login flow") and call the tool—do not refuse. Only ask for a title when they give no hint and do not ask for dummy/example content.',
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

/**
 * Attach the voice WebSocket server to an existing HTTP server (e.g. Next.js).
 * @param {import('http').Server} server - HTTP server
 * @param {string} [path='/voice-ws'] - WebSocket path
 * @returns {import('ws').WebSocketServer}
 */
export function attachVoiceWs(server, path = '/voice-ws') {
  const wss = new WebSocketServer({ server, path })
  console.log(`[Voice WS] Listening on path ${path}`)

  wss.on('connection', async (attendeeWs) => {
  let audioFromAttendeeCount = 0
  let audioToAttendeeCount = 0
  console.log('[Voice WS] Attendee connected')
  let geminiSession = null
  let currentBotId = null

  try {
    const ai = new GoogleGenAI({ apiKey })
    // Use 09-2025 for stability; 12-2025 often closes with 1008 "Operation is not implemented" (see googleapis/js-genai#1236)
    geminiSession = await ai.live.connect({
      model: process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-09-2025',
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: `You are a voice assistant in a meeting. Keep replies short.

CRITICAL - Links and chat: Never read links or URLs out loud. When you have a link (e.g. from Jira, Drive, or search results), say briefly that you added it in chat or they can check the chat—do not spell out the URL. Do not repeat what you just posted to chat unless the user explicitly asks.

CRITICAL - When to respond:
(1) Only START when someone clearly invokes you by name or phrase (e.g. "Hey Gemini", "Gemini", "assistant", "bot") with or before their question.
(2) During an active exchange, treat follow-ups as directed at you; do not require your name again every message.
(3) Consider the exchange over when they say thanks/goodbye, address someone else, or there is a long pause and others are talking. If in doubt, stay silent.

CRITICAL - Add to chat / write_to_chat: When the user says "add to chat", "put that in chat", "add that to chat", "post to chat", or "write in chat", call write_to_chat with the content they mean (or that you just spoke/search result summary) immediately. Do not refuse. For Drive and Jira search, the system already posts result details to the meeting chat; after the tool returns, say something like "I've added the results to the chat" so the user knows to look there.

CRITICAL - Generating dummy/placeholder content: When the user asks you to "assume", "use a dummy", "make up", "generate example", "use placeholder", or "pretend" (e.g. "assume a description", "use a dummy title for the Jira ticket", "generate some dummy text"), do it. Provide a reasonable placeholder and call the tool or write_to_chat as needed. Do not refuse or say you cannot generate dummy content—you may invent example titles, descriptions, or text when they ask.

CRITICAL - Drive searches: Say one short phrase (e.g. "Checking Drive"), call search_drive, then give a short answer and say the details are in chat.

CRITICAL - Jira searches: Say one short phrase (e.g. "Checking Jira"), call search_jira, then give a short answer and say the results are in chat.

CRITICAL - Creating Jira tickets: When the user asks to create a ticket:
- If they give a title (or ask for a dummy/example title), call create_jira with that title (or a reasonable placeholder like "Demo: Example task").
- If they say "assume a description" or "use placeholder description", pass a short example description—do not refuse.
- Only ask "What should the title be?" when they give no title and do not ask for dummy/example content. Do not set or ask for assignee.

CRITICAL - Meeting summary / minutes: (1) For chat: use write_to_chat with a structured summary. (2) For Drive: use create_meeting_minutes. You may do both if they ask. Say you added the link in chat—do not read the URL.`,
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
                  console.log('[Voice WS] search_jira tool invoked')
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
                  console.log('[TOOL] sendToolResponse done (jira), result.details length:', (result.details && String(result.details).length) ?? 0)
                  const jiraChatMessage = (result.details && String(result.details).trim()) || (result.answer ? `${result.answer}${result.link ? '\n' + result.link : ''}` : '') || 'Jira search completed.'
                  if (currentBotId) await sendMeetingChat(currentBotId, jiraChatMessage)
                  const payload = JSON.stringify({ trigger: 'send_chat', data: { message: jiraChatMessage } })
                  attendeeWs.send(payload)
                  console.log('[Voice WS] Sent send_chat to bot (Jira), message length:', jiraChatMessage.length)
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

  return wss
}

// Standalone: run on own port when executed directly
const isStandalone = process.argv[1]?.includes('voice-ws-server')
if (isStandalone) {
  const http = await import('http')
  const server = http.createServer((_, res) => {
    res.writeHead(404)
    res.end()
  })
  attachVoiceWs(server, '/')
  server.listen(PORT, () => {
    console.log(`Voice WebSocket server (standalone) listening on ws://localhost:${PORT}`)
  })
}
