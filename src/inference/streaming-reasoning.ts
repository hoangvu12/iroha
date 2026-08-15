export interface StreamingReasoningState {
  inReasoning: boolean
  pendingBuffer: string
}

export interface StreamingReasoningSplit {
  reasoning: string
  content: string
  inReasoning: boolean
  mutated: boolean
}

const OPEN_TAGS = ['<think>', '<thinking>', '<budget:thinking>']
const CLOSE_TAGS = ['</think>', '</thinking>', '</budget:thinking>']
const TAG_PATTERN = /<\/?(?:think|thinking|budget:thinking)>/g

export function appendStreamingReasoning(
  state: StreamingReasoningState,
  text: string,
): StreamingReasoningSplit {
  state.pendingBuffer += text

  let reasoning = ''
  let content = ''
  let sawClose = false
  let lastIndex = 0

  TAG_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TAG_PATTERN.exec(state.pendingBuffer)) !== null) {
    const isClose = match[0].startsWith('</')
    const between = state.pendingBuffer.slice(lastIndex, match.index)
    if (state.inReasoning) reasoning += between
    else content += between

    if (isClose && state.inReasoning) {
      state.inReasoning = false
      sawClose = true
    } else if (!isClose && !state.inReasoning) {
      state.inReasoning = true
    }

    lastIndex = match.index + match[0].length
  }

  const remaining = state.pendingBuffer.slice(lastIndex)
  const expectedTags = state.inReasoning ? CLOSE_TAGS : OPEN_TAGS
  const partialPrefixLength = longestTagPrefix(remaining, expectedTags)

  if (partialPrefixLength > 0) {
    const safeLength = remaining.length - partialPrefixLength
    const safe = remaining.slice(0, safeLength)
    if (state.inReasoning) reasoning += safe
    else content += safe
    state.pendingBuffer = remaining.slice(safeLength)
  } else {
    if (state.inReasoning) reasoning += remaining
    else content += remaining
    state.pendingBuffer = ''
  }

  const mutated = lastIndex > 0 || partialPrefixLength > 0 || reasoning.length > 0

  if (sawClose && content.length > 0) content = content.replace(/^\s+/, '')

  return { reasoning, content, inReasoning: state.inReasoning, mutated }
}

export function flushStreamingReasoning(
  state: StreamingReasoningState,
): { reasoning: string; content: string } | null {
  if (state.pendingBuffer.length === 0) return null

  const remaining = state.pendingBuffer
  state.pendingBuffer = ''
  return state.inReasoning
    ? { reasoning: remaining, content: '' }
    : { reasoning: '', content: remaining }
}

function longestTagPrefix(text: string, tags: readonly string[]): number {
  let best = 0
  for (const tag of tags) {
    for (let length = 1; length < tag.length; length++) {
      if (length > best && text.endsWith(tag.slice(0, length))) best = length
    }
  }
  return best
}
