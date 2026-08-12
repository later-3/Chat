# Orca workbench visual evidence v0.1

Evidence source: official `stablyai/orca` repository at commit
`23cbe6dfe24269e380e57ad381e5a4ae23ede48a`.

This folder contains research evidence only. It is not a prototype and does not
freeze Orca as the seventh reference project.

## Accepted frames

| File | Official source asset | Capture | What it can prove | Evidence limit |
| --- | --- | --- | --- | --- |
| `screenshots/01-overview-marketing-composite.jpg` | `docs/assets/readme-hero.jpg` | original still | Overall desktop regions and the existence of a mobile companion surface | Marketing-composed overview; not accepted as proof of a complete interaction path |
| `screenshots/02-agent-statuses.png` | `docs/assets/agent-statuses.gif` | frame at 4.8 s | Worktree/task list, nested agent rows, status/timing summaries, and adjacent live work output | Does not prove planning, pause/resume, or failure recovery |
| `screenshots/03-diff-annotation.png` | `docs/assets/feature-wall/annotate-diff.gif` | frame at 2.9 s | Line-level human note on an AI-generated diff inside the workbench | Does not by itself prove how the note is delivered to or acted on by an agent |
| `screenshots/04-terminal-splits.png` | `docs/assets/feature-wall/terminal-splits.gif` | frame at 5.7 s | One workbench composing a task list, many terminal panes, and a file tree | Shows composition capacity, not a full multi-agent task lifecycle |

## Rejected as primary evidence

- `parallel-worktrees.jpg`: the official fallback still lands on an embedded
  Example Domain/browser state and does not by itself prove parallel Agent
  orchestration.
- README feature-wall montage: useful for discovery, but too compressed and
  marketing-edited to carry detailed interaction claims.

