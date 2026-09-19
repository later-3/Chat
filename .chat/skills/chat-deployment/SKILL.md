---
name: chat-deployment
description: Install, update, diagnose, or roll back the Chat production service when the user explicitly asks for a Chat deployment operation.
---

# Chat deployment

Deploy Chat through the repository's supported production path. Read `docs/operations/README.md` before acting; it is the authoritative topology, user-configuration, and installation reference.

Loading this Skill does not authorize a production change. Inspecting status and running tests are non-mutating, but restart or other external mutations require an explicit user request to deploy or restart.

## Invariants

- Chat production is one Nitro process serving the embedded PWA frontend, Backend APIs, Workflow runtime, and Pi Agent integration.
- Build from the Chat repository root. Confirm `.chat/project.json` identifies the `chat` Project before using Chat-specific service names.
- The parent repository pins `frontend/`, `pi/` and `nanoclaw/` Submodule commits. Never update a Submodule with `--remote` during deployment.
- On Linux/systemd, use `deploy/chatctl`; do not reproduce its Git, dependency, build, release-switch, service-rendering, or rollback steps by hand.
- Install/update prepare software with services stopped; they do not start services or enable boot startup. Model credentials may be configured through the local UI after start; never invent credentials. Chat has no product login/password.
- Do not start Vite, the historical Pi Web backend, or a second Chat process.
- Do not expose or overwrite existing credentials. The installer may create missing service tokens; Provider/IM credentials come from the user or their explicit authentication flow.
- Do not commit, push, discard changes, or change branches unless the user separately asks for that Git operation.
- Do not restart Cloudflare or Relay services during an ordinary Chat deployment. Diagnose those paths only when local Chat health succeeds but public health fails.

## Linux/systemd

1. Chat, Pi, and Chat Frontend are public HTTPS repositories. Do not request or configure a GitHub token, SSH key, or Deploy Key for a normal installation; use `git ls-remote` only when diagnosing network access.
2. Use the command matching the request from the Chat repository root:
   - First install (append --with-nanoclaw for Friend Host): `sudo ./deploy/chatctl install`
   - Update to the requested/default revision: `sudo ./deploy/chatctl update`
   - Read-only deployment diagnosis: `sudo ./deploy/chatctl doctor`
   - User-requested release rollback: `sudo ./deploy/chatctl rollback`
3. Installation and running are separate. Use `chatctl stop` before update, then `chatctl start` after successful install/update. `start/stop/restart/status` own component readiness and failure cleanup; `enable/disable` alone control boot policy. Do not manually start a second Nano service.
4. Model setup is separate from software installation. Point to Chat settings or private configuration files. `doctor` reports missing model configuration without requiring reinstall; no product password exists.
5. After any successful mutation, run `sudo ./deploy/chatctl doctor` and report its result without exposing configuration values.

## macOS existing installation

The automated `chatctl` path currently supports Linux/systemd only. For an existing macOS LaunchAgent installation:

1. Inspect `git status --short --branch` in Chat, `frontend`, and `pi`. Report uncommitted changes and exact commits; do not silently reject an explicitly requested deployment of the current workspace.
2. Run `pnpm verify`. If it fails, stop without restarting production.
3. Restart only the Chat LaunchAgent: `launchctl kickstart -k gui/$(id -u)/com.later.chat.production`.
4. Inspect status with `launchctl print gui/$(id -u)/com.later.chat.production` and recent errors with `tail -n 100 "$HOME/Library/Logs/chat/chat-production.stderr.log"`.
5. Require local health to succeed at `http://127.0.0.1:43110/api/health`.

When the configured public Cloudflare endpoint is part of the requested deployment, read the target from the deployment's `CHAT_PUBLIC_URL` without printing unrelated environment values, then require five consecutive successful `/api/health` requests. The expected payload is `{"ok":true,"service":"chat"}`.

## Failure boundaries

- A failed build is not a deployment. Keep the currently running production Release untouched and report the failing command.
- If restart or local health fails, inspect only the Chat service and its logs first. Do not modify credentials, LaunchAgent/systemd definitions, ports, Tunnel, Nginx, or Relay configuration without evidence and explicit authorization.
- If local health is stable but public checks fail or alternate between success and `503`, inspect both documented Cloudflare connector paths from `docs/operations/network.md`. Do not restart or reconfigure them merely because one request failed.
- On Linux, use `chatctl rollback` only when the user explicitly asks to roll back; never emulate it with destructive Git commands. Report the deployed source and Release state before changing revisions.

## Completion report

Report the operation (`install`, `update`, `doctor`, or `rollback`), exact Chat, Frontend, Pi and NanoClaw commits, active Release, configuration status without secret values, verification result, systemd/LaunchAgent state, and local health. When public deployment was in scope, also report all five public health results. A successful restart without the applicable health checks is not a completed deployment.
