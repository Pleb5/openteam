import {existsSync} from "node:fs"
import {mkdir, readdir, readFile, stat, writeFile} from "node:fs/promises"
import path from "node:path"
import type {DevEnv} from "./dev-env.js"

export type ProjectSignal = {
  stack: string
  file: string
  reason: string
}

export type ProjectCommandHint = {
  purpose: string
  command: string[]
  reason: string
}

export type ProjectProfile = {
  version: 1
  generatedAt: string
  checkout: string
  declaredEnvironment: {
    kind: DevEnv["kind"]
    source?: string
  }
  docs: string[]
  stacks: string[]
  signals: ProjectSignal[]
  likelyCommands: ProjectCommandHint[]
  blockers: string[]
  guidance: string[]
}

const has = (checkout: string, file: string) => existsSync(path.join(checkout, file))

const maybeDoc = async (checkout: string, file: string) => {
  const full = path.join(checkout, file)
  if (!existsSync(full)) return []
  const info = await stat(full)
  if (info.isDirectory()) {
    const children = await readdir(full).catch(() => [])
    return children.length > 0 ? [file] : []
  }
  return [file]
}

const topLevelMatches = async (checkout: string, pattern: RegExp) => {
  const entries = await readdir(checkout).catch(() => [])
  return entries.filter(entry => pattern.test(entry))
}

const packageJsonInfo = async (checkout: string) => {
  const file = path.join(checkout, "package.json")
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      packageManager?: string
      workspaces?: unknown
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    return parsed
  } catch {
    return undefined
  }
}

const packageManagerCommand = (checkout: string, packageManager?: string) => {
  if (packageManager?.startsWith("pnpm@") || has(checkout, "pnpm-lock.yaml")) return "pnpm"
  if (packageManager?.startsWith("yarn@") || has(checkout, "yarn.lock")) return "yarn"
  if (packageManager?.startsWith("bun@") || has(checkout, "bun.lock") || has(checkout, "bun.lockb")) return "bun"
  if (has(checkout, "package-lock.json")) return "npm"
  return "npm"
}

const hasPackageDependency = (
  pkg: Awaited<ReturnType<typeof packageJsonInfo>>,
  pattern: RegExp,
) => {
  const deps = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  }
  return Object.keys(deps).some(name => pattern.test(name))
}

const workspaceProtocolDependencies = (
  pkg: Awaited<ReturnType<typeof packageJsonInfo>>,
) => {
  const deps = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  }
  return Object.entries(deps)
    .filter(([, version]) => version.startsWith("workspace:"))
    .map(([name]) => name)
}

const hasDeclaredWorkspace = (checkout: string, pkg: Awaited<ReturnType<typeof packageJsonInfo>>) =>
  has(checkout, "pnpm-workspace.yaml") || Boolean(pkg?.workspaces)

const addSignal = (signals: ProjectSignal[], stack: string, file: string, reason: string) => {
  signals.push({stack, file, reason})
}

const addCommand = (commands: ProjectCommandHint[], purpose: string, command: string[], reason: string) => {
  if (commands.some(item => item.purpose === purpose && item.command.join("\0") === command.join("\0"))) return
  commands.push({purpose, command, reason})
}

export const projectProfilePath = (checkout: string) =>
  path.join(checkout, ".openteam", "project-profile.json")

export const detectProjectProfile = async (checkout: string, devEnv: DevEnv): Promise<ProjectProfile> => {
  const signals: ProjectSignal[] = []
  const commands: ProjectCommandHint[] = []
  const blockers: string[] = []

  if (has(checkout, "Cargo.toml")) {
    addSignal(signals, "rust", "Cargo.toml", "Rust package/workspace manifest")
    addCommand(commands, "rust check", ["cargo", "check"], "Cargo.toml detected")
    addCommand(commands, "rust test build", ["cargo", "test", "--no-run"], "Cargo.toml detected")
  }
  if (has(checkout, "rust-toolchain.toml") || has(checkout, "rust-toolchain")) {
    addSignal(signals, "rust", has(checkout, "rust-toolchain.toml") ? "rust-toolchain.toml" : "rust-toolchain", "Rust toolchain pin")
  }

  const pkg = await packageJsonInfo(checkout)
  if (pkg || has(checkout, "pnpm-lock.yaml") || has(checkout, "package-lock.json") || has(checkout, "yarn.lock") || has(checkout, "bun.lock") || has(checkout, "bun.lockb")) {
    addSignal(signals, "node", pkg ? "package.json" : "lockfile", "Node/package-manager project")
    const manager = packageManagerCommand(checkout, pkg?.packageManager)
    if (pkg?.scripts?.check) addCommand(commands, "node check", [manager, "run", "check"], "package.json scripts.check detected")
    if (pkg?.scripts?.test) addCommand(commands, "node test", [manager, "run", "test"], "package.json scripts.test detected")
    if (pkg?.scripts?.build) addCommand(commands, "node build", [manager, "run", "build"], "package.json scripts.build detected")
    if (pkg?.scripts?.dev) addCommand(commands, "node dev", [manager, "run", "dev"], "package.json scripts.dev detected")
    const workspaceDeps = workspaceProtocolDependencies(pkg)
    if (workspaceDeps.length > 0 && !hasDeclaredWorkspace(checkout, pkg)) {
      blockers.push(`package.json uses workspace: dependencies (${workspaceDeps.slice(0, 5).join(", ")}${workspaceDeps.length > 5 ? ", ..." : ""}) but this checkout has no workspace manifest; verify from the containing workspace or restore the missing workspace packages before installing.`)
    }
  }
  if (has(checkout, "pnpm-workspace.yaml")) {
    addSignal(signals, "node", "pnpm-workspace.yaml", "pnpm workspace")
  }
  if (hasPackageDependency(pkg, /^electron$/)) {
    addSignal(signals, "electron", "package.json", "Electron desktop app dependency")
    addSignal(signals, "desktop", "package.json", "Desktop app candidate")
  }
  if (
    has(checkout, "src-tauri/tauri.conf.json") ||
    has(checkout, "src-tauri/Cargo.toml") ||
    has(checkout, "tauri.conf.json") ||
    hasPackageDependency(pkg, /^@tauri-apps\//)
  ) {
    addSignal(signals, "tauri", has(checkout, "src-tauri/tauri.conf.json") ? "src-tauri/tauri.conf.json" : "package.json", "Tauri desktop app candidate")
    addSignal(signals, "desktop", has(checkout, "src-tauri/tauri.conf.json") ? "src-tauri/tauri.conf.json" : "package.json", "Desktop app candidate")
  }

  if (has(checkout, "go.mod")) {
    addSignal(signals, "go", "go.mod", "Go module")
    addCommand(commands, "go test", ["go", "test", "./..."], "go.mod detected")
  }
  if (has(checkout, "go.work")) {
    addSignal(signals, "go", "go.work", "Go workspace")
  }

  if (has(checkout, "pyproject.toml")) {
    addSignal(signals, "python", "pyproject.toml", "Python project metadata")
    addCommand(commands, "python tests", ["python", "-m", "pytest"], "pyproject.toml detected; verify against repo docs")
  }
  if (has(checkout, "uv.lock")) addSignal(signals, "python", "uv.lock", "uv-managed Python lockfile")
  if (has(checkout, "requirements.txt")) addSignal(signals, "python", "requirements.txt", "pip requirements file")

  if (has(checkout, "gradlew")) {
    addSignal(signals, "jvm", "gradlew", "Gradle wrapper")
    addCommand(commands, "gradle tasks", ["./gradlew", "tasks"], "Gradle wrapper detected")
  }
  if (has(checkout, "build.gradle") || has(checkout, "build.gradle.kts") || has(checkout, "settings.gradle") || has(checkout, "settings.gradle.kts")) {
    addSignal(signals, "jvm", has(checkout, "build.gradle.kts") ? "build.gradle.kts" : "build.gradle", "Gradle project")
  }
  if (has(checkout, "gradlew") && (has(checkout, "app/build.gradle") || has(checkout, "app/build.gradle.kts") || has(checkout, "AndroidManifest.xml"))) {
    addSignal(signals, "android", "gradlew", "Android/Gradle project candidate")
    blockers.push("Android builds may require an Android SDK/JDK outside the repo-declared environment.")
  }

  if (has(checkout, "Package.swift")) {
    addSignal(signals, "ios", "Package.swift", "Swift package")
    addCommand(commands, "swift build", ["swift", "build"], "Package.swift detected")
  }
  for (const entry of await topLevelMatches(checkout, /\.(xcodeproj|xcworkspace)$/)) {
    addSignal(signals, "ios", entry, "Xcode project/workspace")
    blockers.push("Xcode project builds require macOS/Xcode availability.")
  }
  if (has(checkout, "Podfile")) addSignal(signals, "ios", "Podfile", "CocoaPods project")

  if (has(checkout, "meson.build")) {
    addSignal(signals, "desktop", "meson.build", "Native desktop build candidate")
    addSignal(signals, "gtk", "meson.build", "GTK/meson desktop candidate")
  }
  if (has(checkout, "CMakeLists.txt")) {
    addSignal(signals, "desktop", "CMakeLists.txt", "Native desktop CMake build candidate")
    addSignal(signals, "qt", "CMakeLists.txt", "Qt/CMake desktop candidate")
  }

  if (has(checkout, ".devcontainer/devcontainer.json")) {
    addSignal(signals, "devcontainer", ".devcontainer/devcontainer.json", "Dev Container environment declaration")
  }
  if (has(checkout, "mise.toml")) addSignal(signals, "tool-versions", "mise.toml", "mise tool version declaration")
  if (has(checkout, ".tool-versions")) addSignal(signals, "tool-versions", ".tool-versions", "asdf tool version declaration")
  if (has(checkout, "devenv.nix") || has(checkout, "devenv.yaml")) {
    addSignal(signals, "devenv", has(checkout, "devenv.nix") ? "devenv.nix" : "devenv.yaml", "devenv environment declaration")
  }

  const docs = (await Promise.all([
    maybeDoc(checkout, "AGENTS.md"),
    maybeDoc(checkout, "README.md"),
    maybeDoc(checkout, "CONTRIBUTING.md"),
    maybeDoc(checkout, "DEVELOPMENT.md"),
    maybeDoc(checkout, "docs"),
    maybeDoc(checkout, ".github/workflows"),
    maybeDoc(checkout, ".woodpecker.yml"),
    maybeDoc(checkout, ".gitlab-ci.yml"),
  ])).flat()

  const stacks = Array.from(new Set(signals.map(signal => signal.stack)))

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    checkout,
    declaredEnvironment: {
      kind: devEnv.kind,
      source: devEnv.source,
    },
    docs,
    stacks,
    signals,
    likelyCommands: commands,
    blockers,
    guidance: [
      "Repo docs, declared scripts, and declared development environments override these hints.",
      "Use this profile as a checklist for files and commands to inspect, not as authoritative build policy.",
      "Prefer the smallest repo-native verification command that proves the assigned task is ready.",
    ],
  }
}

export const writeProjectProfile = async (checkout: string, profile: ProjectProfile) => {
  const file = projectProfilePath(checkout)
  await mkdir(path.dirname(file), {recursive: true})
  await writeFile(file, `${JSON.stringify(profile, null, 2)}\n`)
  return file
}

export const projectProfilePromptLines = (profile?: ProjectProfile) => {
  if (!profile) return []
  const commands = profile.likelyCommands
    .slice(0, 6)
    .map(item => `${item.purpose}: ${item.command.join(" ")}`)
  return [
    `Project profile file: .openteam/project-profile.json`,
    `Declared dev environment: ${profile.declaredEnvironment.kind}${profile.declaredEnvironment.source ? ` (${profile.declaredEnvironment.source})` : ""}`,
    `Detected project stacks: ${profile.stacks.join(", ") || "none"}`,
    `Docs/check first: ${profile.docs.slice(0, 8).join(", ") || "none detected"}`,
    `Likely validation commands, hints only: ${commands.join("; ") || "none detected"}`,
    `Known provisioning blockers: ${profile.blockers.slice(0, 5).join(" | ") || "none detected"}`,
    `Repo docs, declared scripts, and declared development environments override openteam project-profile hints.`,
  ]
}
