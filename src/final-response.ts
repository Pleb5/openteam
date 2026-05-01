import {redactSensitiveText} from "./log-redaction.js"
import type {FinalResponseRecord} from "./types.js"

export const FINAL_RESPONSE_CAPTURE_MAX_CHARS = 64_000

export type OutputTailSnapshot = {
  text: string
  truncated: boolean
}

export const createOutputTailCapture = (maxChars = FINAL_RESPONSE_CAPTURE_MAX_CHARS) => {
  let text = ""
  let truncated = false

  const append = (chunk: string) => {
    text += chunk
    if (text.length <= maxChars) return
    text = text.slice(text.length - maxChars)
    truncated = true
  }

  const snapshot = (): OutputTailSnapshot => ({text, truncated})

  return {append, snapshot}
}

const ansiPattern = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

export const normalizeFinalResponseText = (text: string) =>
  redactSensitiveText(text)
    .replace(ansiPattern, "")
    .replace(/\r/g, "")
    .trim()

export const buildFinalResponseRecord = (input: {
  text: string
  source?: FinalResponseRecord["source"]
  capturedAt?: string
  truncated?: boolean
  logFile?: string
}): FinalResponseRecord | undefined => {
  const text = normalizeFinalResponseText(input.text)
  if (!text) return undefined

  return {
    text,
    source: input.source ?? "opencode-output-tail",
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    truncated: Boolean(input.truncated),
    chars: text.length,
    logFile: input.logFile,
  }
}
