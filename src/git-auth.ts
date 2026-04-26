import {chmodSync, existsSync, mkdirSync, writeFileSync} from "node:fs"
import {mkdir, readFile, writeFile} from "node:fs/promises"
import path from "node:path"
import type {AppCfg, ProviderCfg} from "./types.js"

type GitEnv = Record<string, string | undefined>

export type GitCredentialRequest = {
  protocol?: string
  host?: string
  path?: string
  username?: string
  url?: string
}

export type GitCredentialContext = {
  version: 1
  checkout: string
  remoteUrls: string[]
  authUsername?: string
  createdAt: string
}

const smartHttpUrl = (value: string) => /^https?:\/\//i.test(value)

const providerHost = (value: string) => {
  const trimmed = value.trim()
  if (!trimmed) return ""

  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    return url.host.toLowerCase()
  } catch {
    return trimmed.toLowerCase()
  }
}

const providerForUrl = (app: AppCfg, value: string) => {
  if (!smartHttpUrl(value)) return

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return
  }

  const host = url.host.toLowerCase()
  return Object.values(app.config.providers).find(provider => {
    const configuredHost = providerHost(provider.host)
    return configuredHost && provider.token && host === configuredHost
  })
}

const ensureGitAskpass = (app: AppCfg) => {
  const file = path.join(app.config.runtimeRoot, "git", "askpass.sh")
  if (!existsSync(file)) {
    mkdirSync(path.dirname(file), {recursive: true})
    writeFileSync(file, [
      "#!/bin/sh",
      "case \"$1\" in",
      "*Username*) printf '%s\\n' \"${OPENTEAM_GIT_USERNAME:-openteam}\" ;;",
      "*) printf '%s\\n' \"$OPENTEAM_GIT_TOKEN\" ;;",
      "esac",
      "",
    ].join("\n"))
    chmodSync(file, 0o700)
  }
  return file
}

export const gitAuthEnv = (app: AppCfg, value: string, username?: string): GitEnv | undefined => {
  const provider = providerForUrl(app, value)
  if (!provider) return

  return {
    GIT_ASKPASS: ensureGitAskpass(app),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    OPENTEAM_GIT_USERNAME: username || provider.username || "openteam",
    OPENTEAM_GIT_TOKEN: provider.token,
  }
}

const parseCredentialInput = (text: string): GitCredentialRequest => {
  const request: GitCredentialRequest = {}
  for (const raw of text.split(/\r?\n/)) {
    const index = raw.indexOf("=")
    if (index <= 0) continue
    const key = raw.slice(0, index)
    const value = raw.slice(index + 1)
    if (key === "protocol" || key === "host" || key === "path" || key === "username" || key === "url") {
      request[key] = value
    }
  }
  return request
}

const requestUrl = (request: GitCredentialRequest) => {
  if (request.url) return request.url
  if (!request.protocol || !request.host) return ""
  return `${request.protocol}://${request.host}${request.path ? `/${request.path.replace(/^\/+/, "")}` : ""}`
}

const normalizedUrlParts = (value: string) => {
  try {
    const parsed = new URL(value)
    return {
      host: parsed.host.toLowerCase(),
      path: parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase(),
    }
  } catch {
    return {host: "", path: ""}
  }
}

const requestMatchesContext = (request: GitCredentialRequest, context?: GitCredentialContext) => {
  if (!context) return true
  const requested = normalizedUrlParts(requestUrl(request))
  if (!requested.host) return false

  return context.remoteUrls.some(remote => {
    const allowed = normalizedUrlParts(remote)
    if (!allowed.host || allowed.host !== requested.host) return false
    return !requested.path || !allowed.path || requested.path === allowed.path
  })
}

export const credentialContextFile = (checkout: string) =>
  path.join(checkout, ".openteam", "git-credential-context.json")

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`

const ensureCredentialHelperScript = async (app: AppCfg) => {
  const file = path.join(app.config.runtimeRoot, "git", "credential-helper.sh")
  await mkdir(path.dirname(file), {recursive: true})
  await writeFile(file, [
    "#!/bin/sh",
    `exec ${shellQuote(process.execPath)} run ${shellQuote(path.join(app.root, "src", "cli.ts"))} git credential "$@"`,
    "",
  ].join("\n"), {mode: 0o700})
  chmodSync(file, 0o700)
  return file
}

export const configureCheckoutGitAuth = async (
  app: AppCfg,
  checkout: string,
  remoteUrls: string[],
  authUsername?: string,
) => {
  const urls = Array.from(new Set(remoteUrls.filter(smartHttpUrl)))
  if (urls.length === 0) return

  const contextFile = credentialContextFile(checkout)
  await mkdir(path.dirname(contextFile), {recursive: true})
  await writeFile(contextFile, `${JSON.stringify({
    version: 1,
    checkout,
    remoteUrls: urls,
    authUsername,
    createdAt: new Date().toISOString(),
  } satisfies GitCredentialContext, null, 2)}\n`, {mode: 0o600})

  const helper = await ensureCredentialHelperScript(app)
  return {
    contextFile,
    helperCommand: `!${shellQuote(helper)} --context ${shellQuote(contextFile)}`,
  }
}

export const gitCredentialFromStdin = async (app: AppCfg, args: string[], stdin: string) => {
  const operation = args.find(item => item === "get" || item === "store" || item === "erase")
  if (operation && operation !== "get") return ""

  const contextArgIndex = args.indexOf("--context")
  const contextFile = contextArgIndex === -1 ? process.env.OPENTEAM_GIT_CREDENTIAL_CONTEXT : args[contextArgIndex + 1]
  const context = contextFile && existsSync(contextFile)
    ? JSON.parse(await readFile(contextFile, "utf8")) as GitCredentialContext
    : undefined

  const request = parseCredentialInput(stdin)
  const url = requestUrl(request)
  if (!url || !requestMatchesContext(request, context)) return ""

  const provider = providerForUrl(app, url)
  if (!provider) return ""

  const username = context?.authUsername || request.username || provider.username || providerDefaultUsername(provider)
  return [
    `username=${username}`,
    `password=${provider.token}`,
    "",
  ].join("\n")
}

const providerDefaultUsername = (provider: ProviderCfg) => {
  const host = providerHost(provider.host)
  if (provider.type === "gitlab" || host.includes("gitlab")) return "oauth2"
  if (provider.type === "github" || host === "github.com") return "x-access-token"
  return "openteam"
}
