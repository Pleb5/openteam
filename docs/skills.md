# Skills

This document explains how `openteam` uses project-local skills and how role skills should be designed.

## Goal

`openteam` intentionally keeps automation code light.

The runtime provides:

- identity
- DM control plane
- relay/profile seeding
- worktrees
- dev servers
- browser sessions
- OpenCode task execution

Skills provide:

- role-specific judgment
- protocol guidance
- event-shape reminders
- command selection guidance
- workflow discipline

The goal is to see how far the agents can go with a solid runtime foundation plus well-designed skills.

## Where Skills Live

Project-local skills live under:

```text
.opencode/skill/<skill-name>/SKILL.md
```

Current skills:

- `builder-workflow`
- `builder-labels-status`
- `nostr-git-map`
- `nak-git-read`
- `triager-workflow`
- `triager-labels-routing`
- `qa-workflow`

## Default role-to-skill mapping

Suggested default skill stack by role:

### Builder

- `builder-workflow`
- `builder-labels-status`
- `nostr-git-map`
- `nak-git-read`
- global shared `nak` skill

### Triager

- `triager-workflow`
- `triager-labels-routing`
- `nostr-git-map`
- `nak-git-read`
- global shared `nak` skill

### QA

- `qa-workflow`
- `nostr-git-map`
- `nak-git-read`
- global shared `nak` skill

This mapping is guidance, not a hard runtime permission system.

## Skill Design Principles

### 1. Shared skills first

Prefer shared skills for:

- protocol maps
- relay concepts
- `nak` command usage
- repository inspection patterns

Then add role-specific skills for:

- triager behavior
- builder behavior
- qa behavior

### 2. Prefer highest-level tools

When a high-level `nak git ...` command exists, prefer it over raw event construction.

Use raw `nak event` only when necessary, such as:

- label events
- status events
- PR / PR update events
- other unsupported high-level cases

### 3. Keep runtime-owned concerns out of skills

The runtime owns:

- operator task intake DMs
- immediate acknowledgement
- completion/blocker reporting

Skills should not instruct agents to manually send operator DMs unless the task itself is about messaging.

### 4. Use the active codebase as semantic source of truth

Do not hardcode a specific app identity into `openteam` skills.

When exact event semantics matter, the skill should direct the agent to inspect the active codebase's NIP-22 / NIP-32 / NIP-34 implementation before guessing.

### 5. Keep deprecated flows out of default workflow

Example:

- code-carrying patches are deprecated for current builder workflow
- skills should say so clearly and exclude them from the default path

## Current Skill Roles

### `builder-workflow`

Purpose:

- main builder behavior
- inspect first
- build second
- verify third
- publish repo-side Nostr state only when necessary

Important policy:

- no deprecated code-carrying patches in normal builder flow

### `builder-labels-status`

Purpose:

- teach builder when and how to use labels and statuses
- prefer reply before structured state if a reply is sufficient
- use NIP-32 labels and NIP-34 statuses intentionally

### `nostr-git-map`

Purpose:

- canonical event-kind and tag reference
- shared vocabulary for repo announcements, issues, comments, PRs, statuses, labels

### `nak-git-read`

Purpose:

- read-first inspection skill
- teaches the agent to inspect repo state before publishing anything

## What A Good Skill Should Contain

Each skill should include:

- when to use it
- the problem it solves
- preferred commands or APIs
- explicit decision rules
- constraints and anti-patterns
- references for semantic truth when needed

## What A Skill Should Avoid

- app-specific branding or identity baked into the skill text
- instructions that duplicate runtime-owned behavior
- large amounts of raw protocol detail with no decision rules
- vague “be smart” guidance without concrete actions

## Planned Skill Families

Shared:

- `nostr-git-map`
- `nak-git-read`
- future generic `nak-git-publish`

Role-specific:

- `builder-workflow`
- `builder-labels-status`
- `triager-workflow`
- `triager-labels-routing`
- `qa-workflow`

## How To Extend Skills

When adding a new skill:

1. decide whether it is shared or role-specific
2. keep it focused on one workflow slice
3. point to the active codebase for exact semantics when needed
4. encode concrete command patterns and decision rules
5. avoid moving runtime responsibilities into the skill

## Validation Approach

Use this loop:

1. add or refine a skill
2. run a real task with an agent
3. note where the agent still guessed badly
4. tighten the skill rather than adding automation code immediately

This keeps `openteam` generic and lets the skill layer evolve with experience.
