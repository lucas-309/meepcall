import Anthropic from '@anthropic-ai/sdk'
import type { Meeting } from '@shared/types'
import { log } from './log'

const PRIMARY_MODEL = 'claude-sonnet-4-6'

let _client: Anthropic | null = null
function getClient(): Anthropic {
  if (_client) return _client
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set; cannot generate summary.')
  _client = new Anthropic({ apiKey })
  return _client
}

const SYSTEM_PROMPT =
  'You are an AI assistant that summarizes meeting transcripts. ' +
  'You MUST format your response using the following structure:\n\n' +
  '# Participants\n- [List all participants mentioned in the transcript]\n\n' +
  '# Summary\n- [Key discussion point 1]\n- [Key discussion point 2]\n- [Key decisions made]\n- [Include any important deadlines or dates mentioned]\n\n' +
  '# Action Items\n- [Action item 1] - [Responsible person if mentioned]\n- [Action item 2] - [Responsible person if mentioned]\n- [Add any other action items discussed]\n\n' +
  'Stick strictly to this format with these exact section headers. Keep each bullet point concise but informative.'

function buildUserContent(meeting: Meeting): string {
  const transcriptText = (meeting.transcript ?? [])
    .map((e) => `${e.speaker}: ${e.text}`)
    .join('\n')

  let participantsText = ''
  if (meeting.participants && meeting.participants.length > 0) {
    participantsText =
      'Detected participants:\n' +
      meeting.participants.map((p) => `- ${p.name}${p.isHost ? ' (Host)' : ''}`).join('\n')
  }

  return `Summarize the following meeting transcript with the EXACT format specified in your instructions:
${participantsText ? participantsText + '\n\n' : ''}
Transcript:
${transcriptText}`
}

export async function generateMeetingSummary(
  meeting: Meeting,
  onProgress?: (currentText: string) => void
): Promise<string> {
  if (!meeting.transcript || meeting.transcript.length === 0) {
    return 'No transcript available to summarize.'
  }

  log.ai(
    `Generating summary for note=${meeting.id} (${meeting.transcript.length} entries, model=${PRIMARY_MODEL}, stream=${onProgress ? 'yes' : 'no'})`
  )

  try {
    const stream = getClient().messages.stream({
      model: PRIMARY_MODEL,
      max_tokens: 1024,
      thinking: { type: 'disabled' },
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [{ role: 'user', content: buildUserContent(meeting) }]
    })

    let fullText = ''
    if (onProgress) {
      stream.on('text', (delta) => {
        fullText += delta
        onProgress(fullText)
      })
    }

    const final = await stream.finalMessage()

    if (!onProgress) {
      for (const block of final.content) {
        if (block.type === 'text') fullText += block.text
      }
    }

    log.ok(
      'ai',
      `Summary done: ${fullText.length} chars · in=${final.usage.input_tokens} out=${final.usage.output_tokens} cache_read=${final.usage.cache_read_input_tokens ?? 0}`
    )
    return fullText
  } catch (err) {
    log.err('ai', 'Error generating meeting summary:', err)
    if (err instanceof Anthropic.APIError) {
      return `Error generating summary: API status ${err.status}: ${err.message}`
    }
    const e = err as Error
    return `Error generating summary: ${e.message}`
  }
}
