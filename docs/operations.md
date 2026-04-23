# Operations

This document covers day-to-day operation of `openteam`.

## Config Files

Base defaults:

```text
config/openteam.json
```

Machine-specific config:

```text
config/openteam.local.json
```

Local secrets:

```text
config/openteam.secrets.env
```

## Important Variables

Common values expected in secrets/config:

- `OPENTEAM_APP_ROOT`
- `OPENTEAM_GITHUB_TOKEN`
- `OPENTEAM_GITLAB_TOKEN`
- `OPENTEAM_TRIAGER_01_SEC`
- `OPENTEAM_BUILDER_01_SEC`
- `OPENTEAM_QA_01_SEC`
- `NOSTR_CLIENT_KEY` if used

## Core Commands

Sanity check:

```bash
bun run src/cli.ts doctor
```

Prepare one agent workspace:

```bash
bun run src/cli.ts prepare builder-01
```

Direct one-off task:

```bash
bun run src/cli.ts launch builder-01 --task "Investigate issue"
```

Long-lived worker loop:

```bash
bun run src/cli.ts serve builder-01
```

Queue a task into a running worker:

```bash
bun run src/cli.ts enqueue builder-01 --task "Build feature"
```

Relay-list seeding:

```bash
bun run src/cli.ts relay sync builder-01
```

Profile data seeding:

```bash
bun run src/cli.ts profile sync builder-01
```

## Bootstrap Order

Recommended order for a fresh agent identity:

1. fill config and secrets
2. run `doctor`
3. run `relay sync <agent>`
4. run `profile sync <agent>`
5. run one `launch <agent> --task ...` browser bootstrap task
6. then move to `serve <agent>` for mailbox mode

## Worker Management

### Foreground mode

Best for debugging and watching behavior.

Example:

```bash
bun run src/cli.ts serve builder-01
```

### Background mode

For ad hoc runs, backgrounding is possible, but managed services are preferred.

Recommended long-term path:

- `systemd --user`

Current unit files live in:

```text
systemd/
```

### Recommended service workflow

Install or copy user units, then use:

```bash
systemctl --user daemon-reload
systemctl --user start openteam-agent@builder-01
systemctl --user status openteam-agent@builder-01
journalctl --user -u openteam-agent@builder-01 -f
```

Enable all default agents at once:

```bash
systemctl --user enable openteam.target
systemctl --user start openteam.target
```

Keep services alive without interactive login:

```bash
sudo loginctl enable-linger <username>
```

## Logs and State

Runtime root:

```text
runtime/agents/<agentId>/
```

Important paths:

- `workspace/`
- `tasks/queue/`
- `tasks/history/`
- `artifacts/`
- `browser/`
- `worktrees/`
- `state.json`

Typical things to inspect:

- runtime state: `runtime/agents/<agent>/state.json`
- task logs in `artifacts/`
- worker logs in `runtime/logs/` if you run detached workers
- bunker log in the agent artifact directory

## What “Healthy” Looks Like

Healthy startup usually means:

- `doctor` finds `git`, `nak`, and `opencode`
- relay sync shows no missing relay-list entries
- profile sync shows at least one accepted relay for the required profile data
- the browser bootstrap task can log in through the managed bunker
- the worker loop starts without repeated relay/auth errors
- subscription-first DM intake stays connected, with polling only as fallback

## Known Imperfect States

These do not necessarily mean the system is broken:

- some bootstrap/directory relays reject or rate-limit relay-list writes
- some profile-data relays reject events they consider outside their accepted scope
- a subset of relays may fail as long as the required relay set still accepted the event

What matters is:

- required relay-list entries are discoverable
- required profile data is visible to the target client
- the agent can actually do its work

## Operational Warnings

- do not treat one relay-side rejection as a full failure automatically
- keep relay buckets semantically separated
- do not expose raw agent secret keys to browser contexts
- let the runtime own operator DM reporting

## When To Re-seed

Re-run relay or profile sync when:

- you changed relay config
- you changed DM relay targets
- you changed outbox relay identity
- you changed signer relays and want fresh runtime state
- you changed GRASP server preference
- you changed provider tokens

## Current Limits

`openteam` currently provides the runtime foundation and skill-driven role behavior.

It does not yet provide:

- full hard separation of role permissions
- complete automated issue ingestion/routing pipelines
- complete PR publication automation

## Related Docs

- `docs/relay-model.md`
- `docs/event-model.md`
- `docs/skills.md`
- `docs/deployment.md`

Use the runtime plus skills to experiment first, then add automation only where the skill layer clearly falls short.
