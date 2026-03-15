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

const WAKE_WORDS = (process.env.WAKE_WORDS || 'gemini,sidekick,assistant,bot')
  .split(',')
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean)
const botName = (process.env.ZOOM_BOT_NAME || 'Gemini Sidekick').trim()
if (botName) {
  botName.split(/\s+/).forEach((w) => {
    const lower = w.toLowerCase()
    if (lower && !WAKE_WORDS.includes(lower)) WAKE_WORDS.push(lower)
  })
}
if (WAKE_WORDS.length === 0) WAKE_WORDS.push('gemini', 'sidekick', 'assistant', 'bot')

function wakeWordPresent(transcript) {
  if (!transcript || typeof transcript !== 'string') return false
  const t = transcript.trim().toLowerCase()
  if (!t) return false
  return WAKE_WORDS.some((w) => t.includes(w))
}

// Allow response (audio/chat) when we have no transcript yet (API may not send it or sends late) OR when transcript contains wake word. Block only when we have transcript without wake word.
function shouldAllowResponse(transcript) {
  if (!transcript || typeof transcript !== 'string' || transcript.trim() === '') return true
  return wakeWordPresent(transcript)
}

if (!apiKey) {
  console.error('Set NEXT_PUBLIC_GEMINI_API_KEY or GEMINI_API_KEY in .env')
  process.exit(1)
}

const TOOL_INVOCATION_RULE =
  'Only call this tool when the user explicitly says your name or a wake phrase in the same message.'

const VOICE_AGENT_SYSTEM = `You are a voice assistant in a live meeting.

Core behavior:
- Keep spoken replies short and natural.
- If in doubt, stay silent.

Wake-word policy (strict):
- Respond only when the same user message includes your name or a wake phrase ("Gemini", "Gemini Sidekick", "Hey Gemini", "Sidekick", "assistant", "bot").
- Follow-up questions are NOT exceptions; each message must include a wake phrase again.
- If no wake phrase is present in that message, do not respond at all.

Links and chat:
- Never read URLs out loud.
- If you have links (Drive/Jira/search), say the details are in chat.
- Do not repeat chat content unless the user explicitly asks.

Tool usage policy:
- For "add to chat"/"post to chat"/"write in chat", call write_to_chat immediately with the exact intended content.
- For Drive/Jira search, give a brief spoken acknowledgment, call the tool, then mention results are in chat.
- If the user asks for dummy/example/placeholder content, generate reasonable placeholder content and proceed with the tool call.
- For "keep quiet", "mute yourself", or "be quiet", call set_bot_mute with muted=true.
- For "unmute yourself" or "you can speak/listen now", call set_bot_mute with muted=false.
- For create_jira: if a title is provided (or example title requested), create it; ask for a title only when none was provided and no example was requested.
- For meeting summaries: use write_to_chat for chat summaries and create_meeting_minutes to save to Drive when requested.`

const searchDriveTool = {
  functionDeclarations: [
    {
      name: 'search_drive',
      description: `Search the shared Google Drive folder for documents related to the user's request. Use for requests like "check Drive", "find docs about X", or "search files about Y". ${TOOL_INVOCATION_RULE} After the search, the system posts details to meeting chat; verbally tell the user to check chat.`,
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
      description: `Search Jira tickets that match the user's request. Use for requests about ticket status, related issues, or work items. Read-only. ${TOOL_INVOCATION_RULE} After the search, the system posts details to meeting chat; verbally tell the user to check chat.`,
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
      description: `Post a message to meeting chat for all participants. Use when the user asks to add, post, write, or share content in chat (including summaries/minutes/search results). ${TOOL_INVOCATION_RULE} Send the exact message content the user intends.`,
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
      description: `Save meeting minutes to Google Drive (Meetings folder; file name auto-generated). Use when the user asks to save/upload minutes to Drive. ${TOOL_INVOCATION_RULE} If they request dummy/example content, generate reasonable placeholder minutes and proceed.`,
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
      description: `Create a Jira ticket (Story or Sub-task). Use when the user asks to create a ticket/task/story. ${TOOL_INVOCATION_RULE} Accept optional parent key, project key, board ID, and description. If asked for dummy/example text, generate it. Ask for title only when no title hint is provided and no example is requested.`,
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

const setBotMuteTool = {
  functionDeclarations: [
    {
      name: 'set_bot_mute',
      description: `Mute or unmute the bot participant microphone in Zoom. Use for requests like "keep quiet", "mute yourself", "be quiet", "unmute yourself", or "you can speak now". ${TOOL_INVOCATION_RULE}`,
      parameters: {
        type: 'object',
        properties: {
          muted: {
            type: 'boolean',
            description: 'true to mute the bot, false to unmute the bot.',
          },
        },
        required: ['muted'],
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

async function sendMeetingChat(_botId, _message) {
  // Chat is sent to the meeting via the client WebSocket (trigger: send_chat); no external API.
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

  wss.on('connection', async (clientWs) => {
  let audioFromClientCount = 0
  let audioToClientCount = 0
  console.log('[Voice WS] Client connected')
  let geminiSession = null
  let currentBotId = null
  let lastInputTranscript = ''
  let agentMuted = true

  try {
    const ai = new GoogleGenAI({ apiKey })
    // Use 09-2025 for stability; 12-2025 often closes with 1008 "Operation is not implemented" (see googleapis/js-genai#1236)
    geminiSession = await ai.live.connect({
      model: process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-09-2025',
      inputAudioTranscription: {},
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: VOICE_AGENT_SYSTEM,
          tools: [searchDriveTool, searchJiraTool, writeToChatTool, createMeetingMinutesTool, createJiraTool, setBotMuteTool],
          functionCallingConfig: {
            mode: 'AUTO',
            allowedFunctionNames: ['search_drive', 'search_jira', 'write_to_chat', 'create_meeting_minutes', 'create_jira', 'set_bot_mute'],
          },
        },
      callbacks: {
        onopen: () => console.log('[Voice WS] Gemini Live connected'),
        onmessage: async (e) => {
          try {
            const sc = e?.serverContent
            const inputTrans = sc?.inputTranscription ?? sc?.input_transcription
            if (inputTrans?.text != null) {
              lastInputTranscript = String(inputTrans.text).trim()
            }

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
                  if (result.details && shouldAllowResponse(lastInputTranscript)) {
                    if (currentBotId) await sendMeetingChat(currentBotId, result.details)
                    clientWs.send(JSON.stringify({ trigger: 'send_chat', data: { message: result.details } }))
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
                  if (shouldAllowResponse(lastInputTranscript)) {
                    if (currentBotId) await sendMeetingChat(currentBotId, jiraChatMessage)
                    clientWs.send(JSON.stringify({ trigger: 'send_chat', data: { message: jiraChatMessage } }))
                  }
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
                  if (shouldAllowResponse(lastInputTranscript)) {
                    if (currentBotId) await sendMeetingChat(currentBotId, message)
                    clientWs.send(JSON.stringify({ trigger: 'send_chat', data: { message } }))
                  }
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
                  if (result.details && shouldAllowResponse(lastInputTranscript)) {
                    if (currentBotId) await sendMeetingChat(currentBotId, result.details)
                    clientWs.send(JSON.stringify({ trigger: 'send_chat', data: { message: result.details } }))
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
                  if (result.details && shouldAllowResponse(lastInputTranscript)) {
                    if (currentBotId) await sendMeetingChat(currentBotId, result.details)
                    clientWs.send(JSON.stringify({ trigger: 'send_chat', data: { message: result.details } }))
                  }
                  console.log('[TOOL] create_jira done')
                } else if (fc.name === 'set_bot_mute' && geminiSession) {
                  const muted = fc.args?.muted !== false
                  agentMuted = muted
                  clientWs.send(JSON.stringify({ trigger: 'bot_mute_control', data: { muted } }))
                  geminiSession.sendToolResponse({
                    functionResponses: [{
                      id: fc.id,
                      name: 'set_bot_mute',
                      response: {
                        success: true,
                        muted,
                        message: muted ? 'Bot muted.' : 'Bot unmuted.',
                      },
                    }],
                  })
                  console.log('[TOOL] set_bot_mute done:', muted ? 'muted' : 'unmuted')
                }
              }
            }
            const parts = sc?.modelTurn?.parts
            if (Array.isArray(parts) && shouldAllowResponse(lastInputTranscript) && !agentMuted) {
              for (const part of parts) {
                const inlineData = part?.inlineData ?? part?.inline_data
                if (inlineData?.data) {
                  const base64 = inlineData.data
                  clientWs.send(JSON.stringify({
                    trigger: 'realtime_audio.bot_output',
                    data: { chunk: base64, sample_rate: 24000 },
                  }))
                  audioToClientCount++
                  if (audioToClientCount <= 3 || audioToClientCount % 20 === 0) {
                    console.log('[Voice WS] Sent audio to meeting:', audioToClientCount)
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
      clientWs.close()
      return
    }

    clientWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.bot_id) currentBotId = msg.bot_id
        if (msg.data?.bot_id) currentBotId = msg.data.bot_id
        if (msg.trigger === 'agent_mute_state') {
          agentMuted = msg.data?.muted !== false
          console.log('[Voice WS] Agent mic state:', agentMuted ? 'muted (listening OFF)' : 'unmuted (listening ON)')
          return
        }
        if (msg.trigger === 'realtime_audio.mixed' && msg.data?.chunk && geminiSession) {
          if (agentMuted) return
          const pcmBase64 = msg.data.chunk
          geminiSession.sendRealtimeInput({
            audio: { data: pcmBase64, mimeType: 'audio/pcm;rate=16000' },
          })
          audioFromClientCount++
          if (audioFromClientCount <= 3 || audioFromClientCount % 100 === 0) {
            console.log('[Voice WS] Received meeting audio:', audioFromClientCount)
          }
        }
      } catch (err) {
        console.error('[Voice WS] Client message error:', err)
      }
    })

    clientWs.on('close', () => {
      if (geminiSession) {
        try {
          geminiSession.close()
        } catch (_) { }
        geminiSession = null
      }
      console.log('[Voice WS] Client disconnected (received', audioFromClientCount, 'audio, sent', audioToClientCount, ')')
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
