---
name: chat-project-versioning
description: Decide, record, and verify independent versions for Chat, Chat Pi Web, and Chat Pi Agent. Use when planning or publishing a release, assigning requirement or bug-fix versions, deciding which project versions must change, or updating Chat version records.
---

# Chat project versioning

Maintain three independent project versions. A release changes only the version of a project whose own deliverable changed; never synchronize version numbers merely because the projects are integrated.

## Project identities and paths

Use these stable project IDs and repositories:

| Project ID | Repository |
|---|---|
| `chat` | Chat repository root |
| `chat-pi-web` | `frontend/` Submodule |
| `chat-pi-agent` | `pi/` Submodule |

Store version facts below the Chat Home resolved by the Backend. The default Chat Home is `~/.chat`; tests and alternate deployments must honor `CHAT_HOME`.

```text
<CHAT_HOME>/versions/
  chat.json
  chat-pi-web.json
  chat-pi-agent.json
```

Do not store product versions in `<CHAT_HOME>/config.json`: that file is mutable Workflow and Agent runtime configuration. Do not use `package.json`, frontend build variables, Pi package versions, or the current Git checkout as a substitute for these version records.

The Backend owns parsing and atomic writes. The Frontend reads a validated projection through `GET /api/version` and never reads or modifies the files directly.

## Version format

Versions must match `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`.

Interpret `major.iteration.bugfix` as follows:

- Increment `major` for an explicitly designated major or incompatible project change; reset the other two numbers to `0`.
- Increment `iteration` for a new capability or planned iteration within the current major version; reset `bugfix` to `0`.
- Increment `bugfix` when a release contains fixes but no new iteration-level capability.
- When one release contains several change classes, use the highest applicable class and bump once.

Each component is an arbitrary non-negative integer: `0.12.103` is valid. Leading zeroes, prerelease suffixes, build suffixes, and shortened two-component versions are not valid.

`0.0.0` is the initial placeholder for every project. It is not a formal release and has no Git range. The first real release may be `0.0.1`, `0.1.0`, or `1.0.0`, depending on its own change class.

## Independent bump rule

Evaluate each project separately at release time:

- If only Chat Pi Web changed, bump only `chat-pi-web`.
- If only Chat Pi Agent changed, including synchronization of its downstream Pi features, bump only `chat-pi-agent`.
- If another project requires source changes to adapt, bump that project too, using the change class appropriate to its own deliverable.
- If a project has no release-relevant change, do not change its version, timestamp, Git range, or version file.
- A parent-repository commit that only advances a Submodule gitlink does not by itself require a `chat` version bump. Version metadata-only changes also do not recursively cause another bump.

The three numbers do not need to match. The current combination of the three records is the installed integration relationship; the pinned Submodule commits provide the exact code correspondence.

## Version record

Each project file has this shape:

```json
{
  "schemaVersion": 1,
  "projectId": "chat-pi-web",
  "currentVersion": "0.0.1",
  "releases": [
    {
      "version": "0.0.1",
      "updatedAt": "2026-09-02T12:00:00.000Z",
      "git": {
        "baseCommitExclusive": null,
        "headCommitInclusive": "full commit id"
      }
    }
  ]
}
```

An initial file uses `currentVersion: "0.0.0"` and an empty `releases` array.

For every formal release:

- Append exactly one release record and set `currentVersion` to that record's version.
- Use an ISO 8601 UTC timestamp for `updatedAt`.
- Use full Git commit IDs from that project's repository.
- Define the range as `baseCommitExclusive..headCommitInclusive`: the former is excluded and the latter included.
- Use the previous release's `headCommitInclusive` as the next release's base. The first formal release uses `null` as its base.
- Require a non-null base to be an ancestor of the head. Never record uncommitted work as a release head.
- Never edit or remove an older release record to make a later release look correct. Correct metadata mistakes with an explicit, auditable repair.

A release range may contain many commits, requirements, and fixes. A requirement may use several commits, and one bug may require several fix attempts; neither case causes one version bump per commit. If an already published fix needs another release, use the next appropriate `bugfix` version.

## Updating a version

1. Read all three current version records and inspect status and commits in the relevant repositories. Preserve unrelated and uncommitted user changes.
2. Determine which projects have release-relevant changes since their own last release head. Do not infer that integration requires all three versions to change.
3. Classify the highest change level independently for each changed project and calculate its next version.
4. Run the validation required by that repository before recording a release. For Chat releases, follow the root `AGENTS.md`; for a Submodule, follow its own repository instructions.
5. Resolve and verify each changed project's full release-head commit. Stop if work intended for the release is uncommitted or if the range is not valid.
6. Through the Backend's version writer, atomically update only the changed project files: append the release record, update `currentVersion`, and leave all unchanged project files untouched. Writes must use a same-directory temporary file and rename, with restrictive file permissions.
7. Read the files back through the same parser used by `GET /api/version`. Verify the current versions, timestamps, range ancestry, exact Submodule commits, and that unchanged project records did not move.
8. Report the three-version combination and the exact changed-project ranges.

Updating a version record does not authorize committing, tagging, pushing, deploying, restarting services, or publishing externally. Perform those actions only when the user explicitly requests them. Bump once when preparing the release, not automatically on every commit.

## Requirement and bug tracking

Every tracked item must identify both project and version because the same numeric version can exist in all three projects.

- Requirements use `projectId` and `targetVersion`; cross-project requirements list one delivery entry per changed project.
- Bugs use `projectId`, `affectedVersions`, and `fixedInVersions`.
- Commit or pull-request references may be many-to-many and supplement rather than replace the release Git range.
- If investigation shows another project does not need changes, do not add a delivery version for it.

When reporting a release or work item, write qualified versions such as `chat-pi-web@0.0.1`, never an unqualified `0.0.1` when the project could be ambiguous.
