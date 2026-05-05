import {createHash} from "node:crypto"
import {tmpdir} from "node:os"
import path from "node:path"
import process from "node:process"

export const agentBrowserSessionName = (value?: string) => {
  const source = value?.trim() || "session"
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16)
  return `ot-${digest}`
}

export const agentBrowserSocketDir = (env: Record<string, string | undefined> = process.env) => {
  const configured = env.AGENT_BROWSER_SOCKET_DIR?.trim()
  if (configured) return configured
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user"
  return path.join(tmpdir(), `ot-ab-${uid}`)
}
