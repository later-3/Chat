---
name: chat-deployment
description: Install, update, diagnose, or roll back the Chat production service when the user explicitly asks for a Chat deployment operation.
---

# Chat deployment

Deploy Chat through the repository's supported production path. Read `docs/deployment.md` before acting; it is the authoritative topology, user-configuration, and installation reference.

Loading this Skill does not authorize a production change. Inspecting status and running tests are non-mutating, but restart or other external mutations require an explicit user request to deploy or restart.

## Invariants

- Chat production is one Nitro process serving the embedded PWA frontend, Backend APIs, Workflow runtime, and Pi Agent integration.
- Build from the Chat repository root. Confirm `.chat/project.json` identifies the `chat` Project before using Chat-specific service names.
- The parent repository pins `frontend/` and `pi/` Submodule commits. Never update a Submodule with `--remote` during deployment.
- On Linux/systemd, use `deploy/chatctl`; do not reproduce its Git, dependency, build, release-switch, service-rendering, or rollback steps by hand.
- A first install intentionally stops after generating private configuration when the user still needs to set a Web password, Provider credential, or default model. Report those exact files and wait for the user to configure them; never invent credentials.
- Do not start Vite, the historical Pi Web backend, or a second Chat process.
- Do not print or modify credentials, environment secrets, Tunnel credentials, or Pi Provider authentication.
- Do not commit, push, discard changes, or change branches unless the user separately asks for that Git operation.
- Do not restart Cloudflare or Relay services during an ordinary Chat deployment. Diagnose those paths only when local Chat health succeeds but public health fails.

## Linux/systemd

1. Before a first install, verify that the `chat` user can read the Chat, Pi, and Pi Web private repositories. Do not inspect or print its private key.
2. Use the command matching the request from the Chat repository root:
   - First install or continue a configuration-paused install: `sudo ./deploy/chatctl install`
   - Update to the requested/default revision: `sudo ./deploy/chatctl update`
   - Read-only deployment diagnosis: `sudo ./deploy/chatctl doctor`
   - User-requested release rollback: `sudo ./deploy/chatctl rollback`
3. Treat the command result as authoritative. Do not manually restart systemd after `install`, `update`, or `rollback`; those commands own release switching, restart, readiness verification, and automatic recovery.
4. If first install reports pending user configuration, point the user to `/etc/chat/chat.env` and `/home/chat/.chat/agent/settings.json`. The user must set their Web password, Provider API Key or OAuth credential, and an available default Provider/model before rerunning `install`.
5. After any successful mutation, run `sudo ./deploy/chatctl doctor` and report its result without exposing configuration values.

## macOS existing installation

The automated `chatctl` path currently supports Linux/systemd only. For an existing macOS LaunchAgent installation:

1. Inspect `git status --short --branch` in Chat, `frontend`, and `pi`. Report uncommitted changes and exact commits; do not silently reject an explicitly requested deployment of the current workspace.
2. Run `pnpm verify`. If it fails, stop without restarting production.
3. Restart only the Chat LaunchAgent: `launchctl kickstart -k gui/$(id -u)/com.later.chat.production`.
4. Inspect status with `launchctl print gui/$(id -u)/com.later.chat.production` and recent errors with `tail -n 100 "$HOME/Library/Logs/chat/chat-production.stderr.log"`.
5. Require local health to succeed at `http://127.0.0.1:43110/api/health`.

When the documented public Cloudflare endpoint is part of the requested deployment, require five consecutive successful health requests against `https://chat.ai4child.asia/api/health`. The expected payload is `{"ok":true,"service":"chat"}`.

## Failure boundaries

- A failed build is not a deployment. Keep the currently running production Release untouched and report the failing command.
- If restart or local health fails, inspect only the Chat service and its logs first. Do not modify credentials, LaunchAgent/systemd definitions, ports, Tunnel, Nginx, or Relay configuration without evidence and explicit authorization.
- If local health is stable but public checks fail or alternate between success and `503`, inspect both documented Cloudflare connector paths from `docs/deployment.md`. Do not restart or reconfigure them merely because one request failed.
- On Linux, use `chatctl rollback` only when the user explicitly asks to roll back; never emulate it with destructive Git commands. Report the deployed source and Release state before changing revisions.

## Completion report

Report the operation (`install`, `update`, `doctor`, or `rollback`), exact Chat, Frontend, and Pi commits, active Release, configuration status without secret values, verification result, systemd/LaunchAgent state, and local health. When public deployment was in scope, also report all five public health results. A successful restart without the applicable health checks is not a completed deployment.
