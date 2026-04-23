# Deployment

This document describes how to deploy `openteam` on a fresh Linux machine or VPS.

The goal is a reproducible baseline with:

- git
- Bun
- `nak`
- OpenCode CLI
- Chromium for browser-capable agents
- user-level `systemd` services for persistent workers

## Assumptions

- Linux system with `systemd`
- non-root user account for running `openteam`
- outbound network access to relays and git providers
- you will provide local config and secrets after install

## Required dependencies

Runtime:

- `git`
- `curl`
- `unzip`
- `bun`
- `nak`
- `opencode`
- `chromium` or another supported browser executable

Recommended:

- `jq`
- `ripgrep`
- `tmux`

## Package installation

The exact package names vary by distribution.

On Debian/Ubuntu-like systems, a typical baseline is:

```bash
sudo apt update
sudo apt install -y git curl unzip jq ripgrep tmux chromium
```

## Install Bun

Use the official installer or your preferred package method.

Example:

```bash
curl -fsSL https://bun.sh/install | bash
```

Ensure `bun` ends up on the user `PATH`.

## Install `nak`

Install `nak` using your preferred trusted method.

The important requirement is that the final `nak` binary is on `PATH` for the same user that will run `openteam`.

After install, verify:

```bash
nak --help
nak git --help
nak bunker --help
```

## Install OpenCode CLI

Install the `opencode` CLI so it is available on `PATH` for the same user.

Verify:

```bash
opencode --help
opencode run --help
```

## Clone and bootstrap `openteam`

Choose a working directory, then:

```bash
git clone <your-openteam-repo-url> ~/Work/openteam
cd ~/Work/openteam
bun install
bun run check
bun run build
```

## Configure

Tracked defaults live in:

- `config/openteam.json`
- `config/openteam.local.example.json`
- `config/openteam.secrets.env.example`

Create local config:

```bash
cp config/openteam.local.example.json config/openteam.local.json
cp config/openteam.secrets.env.example config/openteam.secrets.env
```

Then fill:

- `OPENTEAM_APP_ROOT`
- provider tokens
- agent secrets
- relay buckets
- `nostr_git.graspServers`
- `nostr_git.gitDataRelays`

## Sanity check

Run:

```bash
bun run src/cli.ts doctor
```

This should confirm at least:

- `git` present
- `nak` present
- `opencode` present
- agent workspaces can be prepared

## First-time seeding

For each agent:

```bash
bun run src/cli.ts relay sync triager-01
bun run src/cli.ts profile sync triager-01

bun run src/cli.ts relay sync builder-01
bun run src/cli.ts profile sync builder-01

bun run src/cli.ts relay sync qa-01
bun run src/cli.ts profile sync qa-01
```

## First browser bootstrap

Before long-lived mailbox mode, run one direct browser task per identity to verify:

- managed bunker login works
- the target app can see synced profile data
- browser automation works on the server

Example:

```bash
bun run src/cli.ts launch builder-01 --task "Open the target app, log in with the remote signer, verify synced profile data is visible, and report exactly what you observed."
```

## Headless on VPS

For a VPS, prefer headless mode unless you have a graphical session.

Set in `config/openteam.local.json`:

- `browser.headless: true`

If you need headed mode on a server, you will need a graphical session or a virtual display stack. That is outside the default deployment path.

## systemd --user setup

`openteam` ships user service files in:

- `systemd/openteam-agent@.service`
- `systemd/openteam.target`

Install them into the user systemd directory:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/openteam-agent@.service ~/.config/systemd/user/
cp systemd/openteam.target ~/.config/systemd/user/
systemctl --user daemon-reload
```

Start one agent:

```bash
systemctl --user start openteam-agent@builder-01
```

Start all default agents:

```bash
systemctl --user start openteam.target
```

Check status:

```bash
systemctl --user status openteam-agent@builder-01
systemctl --user status openteam.target
```

View logs:

```bash
journalctl --user -u openteam-agent@builder-01 -f
```

Enable at login:

```bash
systemctl --user enable openteam.target
```

## Keep user services alive without login

If you want user services to continue when no interactive session is logged in, enable linger for the user:

```bash
sudo loginctl enable-linger <username>
```

This is recommended for VPS use.

## Upgrade procedure

Typical upgrade flow:

```bash
cd ~/Work/openteam
git pull
bun install
bun run check
bun run build
systemctl --user restart openteam.target
```

If relay/profile config changed, re-run:

```bash
bun run src/cli.ts relay sync builder-01
bun run src/cli.ts profile sync builder-01
```

Repeat for each affected agent.

## Minimal healthy state checklist

- `doctor` passes
- relay sync shows no missing relay-list entries
- profile sync reaches at least one required relay
- one direct browser bootstrap task succeeds
- `systemd --user` workers stay up without repeating auth or crash loops
