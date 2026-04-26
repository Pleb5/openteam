---
name: repo-bootstrap
description: Generic repository provisioning workflow for making a managed repo context ready before handoff to a worker.
---

Use this skill when acting in a control-plane or provisioning role and the repository environment may not yet be runnable.

## Intent

Before handing a repository to a worker, ensure the current managed repo context is capable of fulfilling the task.

Default sequence:

1. inspect project documentation
2. detect repository shape
3. initialize missing prerequisites
4. install dependencies with the correct package manager
5. run the smallest setup/verification steps needed to make the environment workable
6. only then hand off to the worker task phase

## Read first

Look for:

- `.openteam/project-profile.json`
- `AGENTS.md`
- `README.md`
- `CONTRIBUTING.md`
- `docs/`
- lockfiles
- workspace files
- `.gitmodules`
- project-specific setup scripts

## Detection checklist

Start from `.openteam/project-profile.json` if present.
It is a checklist of detected signals and likely commands, not authoritative project policy.
Repo docs, declared scripts, and declared development environments override profile hints.

Check for:

- `.gitmodules`
- `.envrc`
- `flake.nix`
- `shell.nix`
- `devcontainer.json`
- `mise.toml`
- `.tool-versions`
- `pnpm-lock.yaml`
- `package-lock.json`
- `yarn.lock`
- `bun.lock`
- `pyproject.toml`
- `Cargo.toml`
- `go.mod`
- `build.gradle` / `gradlew`
- `Package.swift` / `.xcodeproj`

Do not assume one package manager or framework.

## Bootstrap actions

Apply only what the repository actually needs.

Examples:

- initialize submodules if `.gitmodules` exists
- install dependencies with the matching package manager
- if lifecycle scripts fail during install, decide whether to retry with scripts disabled and then run the required build steps manually
- run required prepare/build/bootstrap commands documented by the repo
- run a minimal verification command such as `check`, `build`, or an equivalent health command

## Runtime policy boundary

- use checkout-local scratch/cache/artifact paths from `.openteam/tmp`, `.openteam/cache`, `.openteam/artifacts`, or the `OPENTEAM_*` env vars
- put temporary files, package caches, downloaded artifacts, and generated logs under those paths
- do not use `/tmp`, host-global caches, or paths outside the managed checkout/runtime unless the operator explicitly allows it
- do not run GUI openers or system package installs from provisioning; stop with a concrete blocker if system access is required
- do not run broad destructive cleanup such as `rm -rf` or `git reset --hard`

## Package manager guidance

Prefer the repo's native package manager.

Examples:

- `corepack pnpm install --frozen-lockfile`
- `npm ci`
- `corepack yarn install --immutable`
- `bun install --frozen-lockfile`

Use `corepack` when the plain package-manager binary is unavailable but Corepack is installed.

If the repository expects a package-manager shim that is not on `PATH`, prefer the launcher form instead of assuming global install.

Examples:

- `corepack pnpm ...`
- `corepack yarn ...`

## Workspace packages

If the repository uses local workspace packages, inspect their `package.json` files and exports.

Important rule:

- if workspace packages export built `dist/` entrypoints, the environment is not ready until those built outputs exist

Common pattern:

1. install dependencies
2. if install lifecycle scripts fail, retry with scripts disabled if that still leaves a recoverable workspace
3. build the specific local packages whose exports are required by the app
4. rerun the minimal verification command

Do not assume workspace packages are ready just because the install completed.

## Verification

The provisioning phase is complete when:

- dependencies are installed enough for the task
- required submodules are present
- required local workspace packages resolve correctly
- a minimal verification or setup command succeeds, or you have strong evidence the environment is ready

If blocked, stop with a concrete blocker rather than guessing.

## Handoff rule

Workers should receive a ready-state repository context.

- provision first
- hand off second
- do not make worker roles bootstrap the environment by default

## Anti-patterns

Do not:

- start browser verification before the environment is ready
- blindly run every install/build command you can think of
- assume the same setup as a previous project
- skip docs and infer too much from folder names alone

## Summary

- inspect first
- detect the repo shape
- provision only what is needed
- verify enough to make the task feasible
