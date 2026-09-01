---
name: chat-deployment
description: Build, restart, and verify the Chat production service from the Chat repository when the user explicitly asks to deploy, redeploy, restart, or diagnose a Chat release.
---

# Chat deployment

Deploy the current Chat workspace through the repository's existing production path. Read `docs/deployment.md` before acting; it is the authoritative topology and installation reference.

Loading this Skill does not authorize a production change. Inspecting status and running tests are non-mutating, but restart or other external mutations require an explicit user request to deploy or restart.

## Invariants

- Chat production is one Nitro process serving the embedded PWA frontend, Backend APIs, Workflow runtime, and Pi Agent integration.
- Build from the Chat repository root. Confirm `.chat/project.json` identifies the `chat` Project before using Chat-specific service names.
- The parent repository pins `frontend/` and `pi/` Submodule commits. Never update a Submodule with `--remote` during deployment.
- Do not start Vite, the historical Pi Web backend, or a second Chat process.
- Do not print or modify credentials, environment secrets, Tunnel credentials, or Pi Provider authentication.
- Do not commit, push, discard changes, or change branches unless the user separately asks for that Git operation.
- Do not restart Cloudflare or Relay services during an ordinary Chat deployment. Diagnose those paths only when local Chat health succeeds but public health fails.

## Deploy the current workspace

1. Inspect `git status --short --branch` in Chat, `frontend`, and `pi`. Report uncommitted changes and exact commits; do not silently reject an explicitly requested deployment of the current workspace.
2. Run `pnpm verify`. It is the release gate and produces the complete `.output` containing both Frontend and Backend. If it fails, stop without restarting production.
3. Detect the installed service manager instead of assuming one:
   - macOS: `launchctl print gui/$(id -u)/com.later.chat.production`
   - Linux: `systemctl status chat --no-pager`
4. Restart only the existing Chat service:
   - macOS: `launchctl kickstart -k gui/$(id -u)/com.later.chat.production`
   - Linux: `sudo systemctl restart chat`
5. Confirm the service is running and inspect its recent error output without exposing environment values:
   - macOS status: `launchctl print gui/$(id -u)/com.later.chat.production`
   - macOS logs: `tail -n 100 "$HOME/Library/Logs/chat/chat-production.stderr.log"`
   - Linux: `sudo systemctl status chat --no-pager` and `sudo journalctl -u chat -n 100 --no-pager`
6. Require local health to succeed: `curl --fail --silent --show-error http://127.0.0.1:43110/api/health`.
7. Require five consecutive public health requests to succeed against `https://chat.ai4child.asia/api/health`. The expected payload is `{"ok":true,"service":"chat"}`.

## Failure boundaries

- A failed build is not a deployment. Keep the currently running production process untouched and report the failing command.
- If restart or local health fails, inspect only the Chat service and its logs first. Do not modify credentials, LaunchAgent/systemd definitions, ports, Tunnel, Nginx, or Relay configuration without evidence and explicit authorization.
- If local health is stable but public checks fail or alternate between success and `503`, inspect both documented Cloudflare connector paths from `docs/deployment.md`. Do not restart or reconfigure them merely because one request failed.
- Do not use destructive Git recovery commands to roll back a failed deployment. Report the deployed source state and ask before changing revisions.

## Completion report

Report the exact Chat, Frontend, and Pi commits; whether the workspace was clean; `pnpm verify` results; service manager and running PID or unit state; local health; and all five public health results. A successful restart without both health checks is not a completed deployment.
