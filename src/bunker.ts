import {createWriteStream} from "node:fs"
import {mkdir} from "node:fs/promises"
import {spawn} from "node:child_process"
import path from "node:path"
import type {PreparedAgent} from "./types.js"
import {getSelfNpub, signerRelays} from "./nostr.js"

type SpawnedChild = ReturnType<typeof spawn>

export type RunningBunker = {
  uri: string
  npub: string
  logFile: string
  child: SpawnedChild
  stop: () => void
}

const capture = (
  child: SpawnedChild,
  logFile: string,
  onText: (text: string) => void,
) => {
  const stream = createWriteStream(logFile, {flags: "a"})
  let buffer = ""

  const write = (chunk: unknown) => {
    const text = String(chunk)
    stream.write(text)
    buffer += text
    onText(buffer)
    if (buffer.length > 8192) {
      buffer = buffer.slice(-4096)
    }
  }

  child.stdout?.on("data", write)
  child.stderr?.on("data", write)
  child.on("close", () => stream.end())
}

export const startBunker = async (agent: PreparedAgent): Promise<RunningBunker | undefined> => {
  if (!agent.agent.identity.sec) {
    return
  }

  const relays = signerRelays(agent)
  if (relays.length === 0) {
    return
  }

  await mkdir(agent.paths.artifacts, {recursive: true})
  const logFile = path.join(agent.paths.artifacts, "bunker.log")
  const args = ["bunker", "--persist"]
  if (agent.agent.identity.bunkerProfile) {
    args.push("--profile", agent.agent.identity.bunkerProfile)
  }
  args.push("--sec", agent.agent.identity.sec, ...relays)
  const child = spawn("nak", args, {
    cwd: agent.app.root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  const uri = await new Promise<string>((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill("SIGTERM")
      reject(new Error(`timed out waiting for bunker URI for ${agent.id}`))
    }, 15000)

    capture(child, logFile, text => {
      if (done) return
      const match = text.match(/bunker:\s+(bunker:\/\/\S+)/)
      if (!match) return
      done = true
      clearTimeout(timer)
      resolve(match[1])
    })

    child.on("error", error => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(error)
    })

    child.on("close", code => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(new Error(`nak bunker exited before reporting URI (${code ?? -1})`))
    })
  })

  return {
    uri,
    npub: getSelfNpub(agent),
    logFile,
    child,
    stop: () => child.kill("SIGTERM"),
  }
}
