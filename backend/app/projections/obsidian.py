"""Deterministic Obsidian presentation adapter for Project Dossier envelopes."""

from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any, Iterable, Mapping, Sequence

from .contracts import PROJECT_DOSSIER_VIEW_SCHEMA, ProjectionValidationError, canonical_json

MAX_EXPORT_FILES = 500
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_EXPORT_BYTES = 20 * 1024 * 1024
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


@dataclass(frozen=True, slots=True)
class ProjectionFile:
    path: str
    media_type: str
    content: bytes

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.content).hexdigest()

    def view(self, *, include_content: bool) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "path": self.path,
            "media_type": self.media_type,
            "sha256": self.sha256,
            "size_bytes": len(self.content),
        }
        if include_content:
            payload["content"] = self.content.decode("utf-8")
        return payload


@dataclass(frozen=True, slots=True)
class ObsidianProjectTree:
    schema_version: str
    project_id: str
    projection_revision: str
    source_snapshot_at: str | None
    files: tuple[ProjectionFile, ...]

    @property
    def root_directory(self) -> str:
        return f"Projects/{self.project_id}"

    @property
    def tree_hash(self) -> str:
        return hashlib.sha256(
            canonical_json(
                [
                    {
                        "path": value.path,
                        "sha256": value.sha256,
                        "size_bytes": len(value.content),
                    }
                    for value in self.files
                ]
            ).encode("utf-8")
        ).hexdigest()

    @property
    def archive_name(self) -> str:
        return f"chat-project-{self.project_id}.zip"

    def view(self, *, include_content: bool = True) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "adapter": "obsidian_markdown_readonly_v1",
            "read_only": True,
            "project_id": self.project_id,
            "projection_revision": self.projection_revision,
            "source_snapshot_at": self.source_snapshot_at,
            "root_directory": self.root_directory,
            "tree_hash": self.tree_hash,
            "archive_name": self.archive_name,
            "file_count": len(self.files),
            "total_bytes": sum(len(value.content) for value in self.files),
            "files": [value.view(include_content=include_content) for value in self.files],
        }

    def zip_bytes(self) -> bytes:
        """Return a byte-stable ZIP for this exact file tree."""

        output = io.BytesIO()
        with zipfile.ZipFile(output, mode="w", compression=zipfile.ZIP_STORED) as archive:
            for value in self.files:
                info = zipfile.ZipInfo(value.path, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_STORED
                info.create_system = 3
                info.external_attr = (0o100644 & 0xFFFF) << 16
                info.flag_bits |= 0x800
                archive.writestr(info, value.content)
        return output.getvalue()


def render_obsidian_project_tree(dossier: Mapping[str, Any]) -> ObsidianProjectTree:
    if dossier.get("view_schema") != PROJECT_DOSSIER_VIEW_SCHEMA:
        raise ProjectionValidationError("Obsidian Adapter只接受project-dossier.v1")
    data = _mapping(dossier.get("data"), field="data")
    project = _mapping(data.get("project"), field="data.project")
    project_id = _safe_identifier(project.get("id"), field="project.id")
    projection_revision = _safe_hash(dossier.get("projection_revision"))
    project_root = f"Projects/{project_id}"

    files: list[ProjectionFile] = []
    files.append(
        _markdown_file(
            "README.md",
            _vault_readme(project=project, project_root=project_root, dossier=dossier),
        )
    )
    files.append(
        _markdown_file(
            f"{project_root}/README.md",
            _project_readme(project=project, data=data, dossier=dossier),
        )
    )

    work_details = _sequence(data.get("work_items"), field="data.work_items")
    for detail_value in work_details:
        detail = _mapping(detail_value, field="work_item_detail")
        work = _mapping(detail.get("work_item"), field="work_item_detail.work_item")
        work_id = _safe_identifier(work.get("id"), field="work_item.id")
        files.append(
            _markdown_file(
                f"{project_root}/Work/{work_id}.md",
                _work_markdown(work=work, plan=detail.get("plan"), dossier=dossier),
            )
        )

    role_lanes = _sequence(data.get("role_lanes"), field="data.role_lanes")
    for lane_value in role_lanes:
        lane = _mapping(lane_value, field="role_lane")
        assignee = _safe_identifier(lane.get("assignee_kind"), field="role_lane.assignee_kind")
        files.append(
            _markdown_file(
                f"{project_root}/Responsibilities/{assignee}.md",
                _responsibility_markdown(lane=lane, project=project, dossier=dossier),
            )
        )

    knowledge = _mapping(data.get("knowledge"), field="data.knowledge")
    for note_value in _sequence(knowledge.get("notes"), field="data.knowledge.notes"):
        note = _mapping(note_value, field="note")
        note_id = _safe_identifier(note.get("id"), field="note.id")
        files.append(
            _markdown_file(
                f"{project_root}/Knowledge/{note_id}.md",
                _note_markdown(note=note, dossier=dossier),
            )
        )

    files.extend(
        (
            _markdown_file(
                f"{project_root}/Evidence/README.md",
                _evidence_markdown(data=data, project=project, dossier=dossier),
            ),
            _markdown_file(
                f"{project_root}/Resources/repositories.md",
                _repositories_markdown(data=data, project=project, dossier=dossier),
            ),
            _markdown_file(
                f"{project_root}/Methods/protocol.md",
                _protocol_markdown(data=data, project=project, dossier=dossier),
            ),
            _markdown_file(
                f"{project_root}/Reviews/current.md",
                _review_markdown(data=data, project=project, dossier=dossier),
            ),
        )
    )
    if data.get("domain") == "learning":
        files.append(
            _markdown_file(
                f"{project_root}/Learning/review-queue.md",
                _learning_markdown(data=data, project=project, dossier=dossier),
            )
        )

    ordered_payload = tuple(sorted(files, key=lambda value: value.path))
    _validate_files(ordered_payload)
    manifest = {
        "schema_version": "obsidian-project-tree.v1",
        "adapter": "obsidian_markdown_readonly_v1",
        "read_only": True,
        "project_id": project_id,
        "projection_schema": dossier["view_schema"],
        "projection_revision": projection_revision,
        "source_snapshot_at": dossier.get("source_snapshot_at"),
        "source_revisions": dossier.get("source_revisions") or [],
        "files": [value.view(include_content=False) for value in ordered_payload],
    }
    manifest["payload_tree_hash"] = hashlib.sha256(
        canonical_json(manifest["files"]).encode("utf-8")
    ).hexdigest()
    manifest_file = ProjectionFile(
        path=f"{project_root}/.chat-projection/manifest.json",
        media_type="application/json",
        content=(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"),
    )
    final_files = tuple(sorted((*ordered_payload, manifest_file), key=lambda value: value.path))
    _validate_files(final_files)
    return ObsidianProjectTree(
        schema_version="obsidian-project-tree.v1",
        project_id=project_id,
        projection_revision=projection_revision,
        source_snapshot_at=str(dossier.get("source_snapshot_at"))
        if dossier.get("source_snapshot_at")
        else None,
        files=final_files,
    )


def _vault_readme(*, project: Mapping[str, Any], project_root: str, dossier: Mapping[str, Any]) -> str:
    return _document(
        frontmatter=_frontmatter(
            dossier=dossier,
            chat_kind="vault_index",
            chat_id=str(project["id"]),
            source_revision=project["row_version"],
        ),
        title="Chat Obsidian 只读投影",
        body=(
            "> 这组文件由 Chat Product Store 的同一份权威事实生成。请勿把本目录当成第二事实源。\n\n"
            f"- 项目：[[{project_root}/README|{_inline(project['title'])}]]\n"
            f"- Project ID：`{project['id']}`\n"
            f"- Projection revision：`{dossier['projection_revision']}`\n"
            "- 当前能力：只读快照；在 Obsidian 中编辑不会写回 Chat。\n"
        ),
    )


def _project_readme(
    *, project: Mapping[str, Any], data: Mapping[str, Any], dossier: Mapping[str, Any]
) -> str:
    sections = _mapping(dossier.get("sections"), field="sections")
    next_actions = _sequence(data.get("next_actions"), field="data.next_actions")
    attention = _sequence(data.get("attention"), field="data.attention")
    counts = _mapping(data.get("counts"), field="data.counts")
    body = [
        f"## 目标\n\n{_text(project.get('goal'))}\n",
        "## 当前状态\n",
        f"- 类型：`{project.get('kind')}` / 领域：`{data.get('domain')}`",
        f"- 状态：`{project.get('status')}`",
        f"- Project revision：`{project.get('row_version')}`",
        f"- 开放 Work：{counts.get('open_work', 0)}；开放 Action：{counts.get('open_actions', 0)}；阻塞：{counts.get('blocked', 0)}",
        "\n## 下一行动\n",
        _responsibility_list(next_actions, empty="当前没有正式下一行动。"),
        "\n## 需要关注\n",
        _attention_list(attention),
        "\n## 责任入口\n",
        "- [[Responsibilities/user|你来做]]",
        "- [[Responsibilities/agent|Chat / AI执行]]",
        "- [[Responsibilities/external|外部协作]]",
        "\n## 数据完整性\n",
        *[
            f"- `{key}`：`{_mapping(value, field='section').get('state')}`"
            + (
                f"（{_mapping(value, field='section').get('reason_code')}）"
                if _mapping(value, field="section").get("reason_code")
                else ""
            )
            for key, value in sorted(sections.items())
        ],
    ]
    return _document(
        frontmatter=_frontmatter(
            dossier=dossier,
            chat_kind="project",
            chat_id=str(project["id"]),
            source_revision=project["row_version"],
            extra={"project_kind": project.get("kind"), "status": project.get("status")},
        ),
        title=str(project.get("title") or "未命名Project"),
        body="\n".join(body),
    )


def _work_markdown(*, work: Mapping[str, Any], plan: Any, dossier: Mapping[str, Any]) -> str:
    body = [
        "## 目标",
        _text(work.get("objective")),
        "",
        "## 状态",
        f"- 状态：`{work.get('status')}`",
        f"- 类型：`{work.get('kind')}`",
        f"- 优先级：`{work.get('priority')}`",
        f"- revision：`{work.get('row_version')}`",
    ]
    if isinstance(plan, Mapping) and isinstance(plan.get("revision"), Mapping):
        revision = _mapping(plan["revision"], field="plan.revision")
        body.extend(("", "## 当前已接受计划", _text(revision.get("summary")), ""))
        for node_value in _sequence(revision.get("nodes"), field="plan.nodes"):
            node = _mapping(node_value, field="plan.node")
            body.append(
                f"- [{_checkbox(node.get('status'))}] {_inline(node.get('title'))} "
                f"— `{node.get('assignee_kind')}` / `{node.get('status')}`"
            )
    else:
        body.extend(("", "## 当前计划", "尚无已接受Plan revision。"))
    return _document(
        frontmatter=_frontmatter(
            dossier=dossier,
            chat_kind="work_item",
            chat_id=str(work["id"]),
            source_revision=work["row_version"],
            extra={"status": work.get("status"), "assignee": None},
        ),
        title=str(work.get("title") or "未命名Work"),
        body="\n".join(body),
    )


def _responsibility_markdown(
    *, lane: Mapping[str, Any], project: Mapping[str, Any], dossier: Mapping[str, Any]
) -> str:
    return _document(
        frontmatter=_frontmatter(
            dossier=dossier,
            chat_kind="responsibility_lane",
            chat_id=f"{project['id']}:{lane['assignee_kind']}",
            source_revision=dossier["projection_revision"],
            extra={"assignee_kind": lane.get("assignee_kind")},
        ),
        title=str(lane.get("label") or lane.get("assignee_kind") or "责任"),
        body=(
            f"{_text(lane.get('description'))}\n\n"
            + _responsibility_list(
                _sequence(lane.get("items"), field="role_lane.items"),
                empty="当前没有该责任主体的正式Action或已接受Plan步骤。",
            )
        ),
    )


def _note_markdown(*, note: Mapping[str, Any], dossier: Mapping[str, Any]) -> str:
    revision = note.get("current_revision")
    current = _mapping(revision, field="note.current_revision") if isinstance(revision, Mapping) else {}
    source_refs = current.get("source_refs") or []
    body = _text(current.get("content"))
    if source_refs:
        body += "\n\n## 来源引用\n\n```json\n" + canonical_json(source_refs) + "\n```\n"
    return _document(
        frontmatter=_frontmatter(
            dossier=dossier,
            chat_kind="note",
            chat_id=str(note["id"]),
            source_revision=f"{note.get('row_version')}:{current.get('revision', 0)}",
            extra={"note_kind": note.get("kind"), "status": note.get("status")},
        ),
        title=str(note.get("title") or "未命名Note"),
        body=body,
    )


def _evidence_markdown(
    *, data: Mapping[str, Any], project: Mapping[str, Any], dossier: Mapping[str, Any]
) -> str:
    evidence = _mapping(data.get("evidence"), field="data.evidence")
    values = _sequence(evidence.get("references"), field="data.evidence.references")
    body = [
        "> 当前只包含Work/Action已经提交的Evidence引用；完整Artifact、Claim与Validity视图尚未接入。",
        "",
    ]
    if not values:
        body.append("当前投影没有可显示的Evidence引用；这不等于系统已经证明不存在Evidence。")
    for value in values:
        item = _mapping(value, field="evidence_reference")
        body.extend(
            (
                f"## {_inline(item.get('subject_title'))}",
                f"- Subject：`{item.get('subject_kind')}/{item.get('subject_id')}`",
                "```json",
                canonical_json(item.get("reference")),
                "```",
                "",
            )
        )
    return _document(
        frontmatter=_frontmatter(
            dossier=dossier,
            chat_kind="evidence_index",
            chat_id=str(project["id"]),
            source_revision=dossier["projection_revision"],
        ),
        title="Evidence",
        body="\n".join(body),
    )


def _repositories_markdown(
    *, data: Mapping[str, Any], project: Mapping[str, Any], dossier: Mapping[str, Any]
) -> str:
    values = _sequence(data.get("repositories"), field="data.repositories")
    body: list[str] = []
    if not values:
        body.append("当前Project没有Repository Binding，或该区块不可用。")
    for value in values:
        item = _mapping(value, field="repository_summary")
        binding = _mapping(item.get("binding"), field="repository_summary.binding")
        latest = item.get("latest_snapshot")
        available = item.get("last_available_snapshot")
        snapshot = latest if isinstance(latest, Mapping) else available
        body.extend(
            (
                f"## {_inline(binding.get('display_name'))}",
                f"- Alias：`{binding.get('alias')}`",
                f"- Role：`{binding.get('role')}`",
                f"- Status：`{binding.get('status')}`",
                f"- Relative path：`{binding.get('relative_path')}`",
            )
        )
        if isinstance(snapshot, Mapping):
            body.extend(
                (
                    f"- Snapshot：`{snapshot.get('capture_status')}`",
                    f"- HEAD：`{snapshot.get('head_oid') or 'UNBORN'}`",
                    f"- Dirty：`{snapshot.get('dirty')}`",
                )
            )
        body.append("")
    return _document(
        frontmatter=_frontmatter(
            dossier=dossier,
            chat_kind="repository_index",
            chat_id=str(project["id"]),
            source_revision=dossier["projection_revision"],
        ),
        title="代码与文件资源",
        body="\n".join(body),
    )


def _protocol_markdown(
    *, data: Mapping[str, Any], project: Mapping[str, Any], dossier: Mapping[str, Any]
) -> str:
    protocol = data.get("protocol")
    if not isinstance(protocol, Mapping):
        body = "当前没有可解析的有效协作方法；请查看Project Dossier中的unknown原因。"
    else:
        phases = protocol.get("phases") or []
        body = (
            f"{_text(protocol.get('description'))}\n\n"
            f"- Key：`{protocol.get('protocol_key')}`\n"
            f"- Revision：`{protocol.get('revision')}`\n"
            f"- Binding来源：`{protocol.get('selection_source')}`\n"
            f"- 选择原因：{_text(protocol.get('selection_reason'))}\n\n"
            "## 阶段\n\n"
            + ("\n".join(f"- {_inline(value)}" for value in phases) if phases else "尚无公开阶段。")
        )
    return _document(
        frontmatter=_frontmatter(
            dossier=dossier,
            chat_kind="protocol_projection",
            chat_id=str(project["id"]),
            source_revision=dossier["projection_revision"],
        ),
        title="协作方法",
        body=body,
    )


def _review_markdown(
    *, data: Mapping[str, Any], project: Mapping[str, Any], dossier: Mapping[str, Any]
) -> str:
    attention = _sequence(data.get("attention"), field="data.attention")
    activity = _sequence(data.get("activity"), field="data.activity")
    body = [
        "## 当前需要关注",
        _attention_list(attention),
        "",
        "## 最近推进",
    ]
    if not activity:
        body.append("暂无可显示的Harness活动。")
    for value in activity[:20]:
        event = _mapping(value, field="activity")
        body.append(
            f"- `{event.get('created_at')}` · `{event.get('event_type')}` · "
            f"`{event.get('resource_kind')}/{event.get('resource_id')}`"
        )
    body.extend(
        (
            "",
            "## 仍不可确定",
            "- Schedule、Delivery和完整Artifact/Evidence关系请以Dossier区块状态为准。",
            "- 本文件是只读快照，不会因你在Obsidian勾选任务而更新Product Store。",
        )
    )
    return _document(
        frontmatter=_frontmatter(
            dossier=dossier,
            chat_kind="project_review",
            chat_id=str(project["id"]),
            source_revision=dossier["projection_revision"],
        ),
        title="当前复盘",
        body="\n".join(body),
    )


def _learning_markdown(
    *, data: Mapping[str, Any], project: Mapping[str, Any], dossier: Mapping[str, Any]
) -> str:
    progress = _mapping(data.get("count_progress"), field="data.count_progress")
    return _document(
        frontmatter=_frontmatter(
            dossier=dossier,
            chat_kind="learning_review_queue",
            chat_id=str(project["id"]),
            source_revision=dossier["projection_revision"],
        ),
        title="学习复习队列",
        body=(
            f"- 已完成学习Work：{progress.get('completed', 0)} / {progress.get('total', 0)}\n"
            "- 下一复习时间：未知（`schedule_not_implemented`）\n\n"
            "## 当前练习与下一行动\n\n"
            + _responsibility_list(
                _sequence(data.get("next_actions"), field="data.next_actions"),
                empty="当前没有正式学习Action。",
            )
            + "\n\n> 数量只表示Work状态，不代表已经掌握；掌握需要Evidence。\n"
        ),
    )


def _frontmatter(
    *,
    dossier: Mapping[str, Any],
    chat_kind: str,
    chat_id: str,
    source_revision: Any,
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    result = {
        "chat_schema": "obsidian-project-file.v1",
        "chat_kind": chat_kind,
        "chat_id": chat_id,
        "source_revision": str(source_revision),
        "projection_schema": dossier["view_schema"],
        "projection_revision": dossier["projection_revision"],
        "source_snapshot_at": dossier.get("source_snapshot_at"),
        "read_only": True,
    }
    if extra:
        result.update(extra)
    return result


def _document(*, frontmatter: Mapping[str, Any], title: str, body: str) -> str:
    lines = ["---"]
    for key, value in frontmatter.items():
        lines.append(f"{key}: {json.dumps(value, ensure_ascii=False)}")
    lines.extend(("---", "", f"# {_inline(title)}", "", _text(body).rstrip(), ""))
    return "\n".join(lines)


def _responsibility_list(values: Sequence[Any], *, empty: str) -> str:
    if not values:
        return empty
    lines = []
    for raw in values:
        value = _mapping(raw, field="responsibility")
        lines.append(
            f"- [{_checkbox(value.get('status'))}] {_inline(value.get('title'))} "
            f"— `{value.get('assignee_kind')}` / `{value.get('status')}`"
            + (f" / due `{value.get('due_at')}`" if value.get("due_at") else "")
        )
    return "\n".join(lines)


def _attention_list(values: Sequence[Any]) -> str:
    if not values:
        return "当前没有Projection识别出的关注项。"
    return "\n".join(
        f"- {_inline(_mapping(value, field='attention').get('title'))} "
        f"(`{_mapping(value, field='attention').get('reason_code')}`)"
        for value in values
    )


def _checkbox(status: Any) -> str:
    return "x" if status == "completed" else " "


def _markdown_file(path: str, content: str) -> ProjectionFile:
    _validate_path(path)
    return ProjectionFile(path=path, media_type="text/markdown", content=content.encode("utf-8"))


def _validate_files(files: Iterable[ProjectionFile]) -> None:
    values = tuple(files)
    if len(values) > MAX_EXPORT_FILES:
        raise ProjectionValidationError("Obsidian导出文件数超过限制")
    folded: set[str] = set()
    total = 0
    for value in values:
        _validate_path(value.path)
        if len(value.content) > MAX_FILE_BYTES:
            raise ProjectionValidationError(f"Obsidian文件过大: {value.path}")
        folded_path = value.path.casefold()
        if folded_path in folded:
            raise ProjectionValidationError(f"Obsidian路径大小写冲突: {value.path}")
        folded.add(folded_path)
        total += len(value.content)
    if total > MAX_EXPORT_BYTES:
        raise ProjectionValidationError("Obsidian导出总大小超过限制")


def _validate_path(path: str) -> None:
    if not path or "\x00" in path or "\\" in path or any(ord(value) < 32 for value in path):
        raise ProjectionValidationError("Obsidian投影路径无效")
    parsed = PurePosixPath(path)
    if parsed.is_absolute() or any(part in {"", ".", ".."} for part in parsed.parts):
        raise ProjectionValidationError("Obsidian投影路径越界")


def _safe_identifier(value: Any, *, field: str) -> str:
    text = str(value or "")
    if not _SAFE_ID.fullmatch(text) or text in {".", ".."}:
        raise ProjectionValidationError(f"{field}不是安全稳定ID")
    return text


def _safe_hash(value: Any) -> str:
    text = str(value or "")
    if not re.fullmatch(r"[a-f0-9]{64}", text):
        raise ProjectionValidationError("projection_revision无效")
    return text


def _mapping(value: Any, *, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ProjectionValidationError(f"{field}必须是对象")
    return value


def _sequence(value: Any, *, field: str) -> Sequence[Any]:
    if not isinstance(value, Sequence) or isinstance(value, str | bytes | bytearray):
        raise ProjectionValidationError(f"{field}必须是数组")
    return value


def _text(value: Any) -> str:
    return str(value or "").replace("\x00", "�")


def _inline(value: Any) -> str:
    return " ".join(_text(value).splitlines()).replace("|", "\\|")
