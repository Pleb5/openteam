import {existsSync} from "node:fs"
import {readFile} from "node:fs/promises"
import path from "node:path"

export type DevEnvKind = "none" | "nix-flake" | "nix-shell"

export type DevEnv = {
  kind: DevEnvKind
  source?: string
  commandPrefix: string[]
}

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`

const commandLine = (cmd: string, args: string[]) =>
  [cmd, ...args].map(shellQuote).join(" ")

const envrcRequestsFlake = async (checkout: string) => {
  const file = path.join(checkout, ".envrc")
  if (!existsSync(file)) return false
  const text = await readFile(file, "utf8")
  return /^\s*use\s+flake(?:\s|$)/m.test(text)
}

const envrcRequestsNixShell = async (checkout: string) => {
  const file = path.join(checkout, ".envrc")
  if (!existsSync(file)) return false
  const text = await readFile(file, "utf8")
  return /^\s*use\s+nix(?:\s|$)/m.test(text)
}

export const detectDevEnv = async (checkout: string): Promise<DevEnv> => {
  if ((await envrcRequestsFlake(checkout)) || existsSync(path.join(checkout, "flake.nix"))) {
    return {
      kind: "nix-flake",
      source: existsSync(path.join(checkout, ".envrc")) ? ".envrc" : "flake.nix",
      commandPrefix: ["nix", "develop", "--command"],
    }
  }

  if ((await envrcRequestsNixShell(checkout)) || existsSync(path.join(checkout, "shell.nix")) || existsSync(path.join(checkout, "default.nix"))) {
    return {
      kind: "nix-shell",
      source: existsSync(path.join(checkout, ".envrc"))
        ? ".envrc"
        : existsSync(path.join(checkout, "shell.nix"))
          ? "shell.nix"
          : "default.nix",
      commandPrefix: ["nix-shell", "--run"],
    }
  }

  return {kind: "none", commandPrefix: []}
}

export const wrapDevEnvCommand = (devEnv: DevEnv | undefined, cmd: string, args: string[]) => {
  if (!devEnv || devEnv.kind === "none") {
    return {cmd, args}
  }

  if (devEnv.kind === "nix-flake") {
    return {
      cmd: "nix",
      args: ["develop", "--command", cmd, ...args],
    }
  }

  return {
    cmd: "nix-shell",
    args: ["--run", commandLine(cmd, args)],
  }
}
