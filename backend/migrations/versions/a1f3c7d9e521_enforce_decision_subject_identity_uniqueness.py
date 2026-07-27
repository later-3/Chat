"""enforce decision subject logical identity uniqueness

Revision ID: a1f3c7d9e521
Revises: ddc1d173586e
Create Date: 2026-07-26 18:40:00.000000

第六轮复审P0-2.1：DecisionSubject的逻辑身份是
(subject_kind, resource_id, resource_revision)。旧唯一键包含subject_hash，
在支持真实并发的数据库上允许同身份不同内容的两个Subject并存，让旧批准
漂移授权。本迁移为逻辑身份增加唯一索引；应用层register_subject在插入前
已经做一致性复核并把竞争翻译为GovernanceConflict。

安全边界：如果既有数据库已经存在同身份多行，迁移明确失败并列出数量，
绝不静默删除或改写既有决定事实（项目规则：不删除数据）。
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a1f3c7d9e521"
down_revision: Union[str, Sequence[str], None] = "ddc1d173586e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    connection = op.get_bind()
    duplicates = connection.execute(
        sa.text(
            "SELECT subject_kind, resource_id, resource_revision, COUNT(*) AS n "
            "FROM decision_subjects "
            "GROUP BY subject_kind, resource_id, resource_revision HAVING COUNT(*) > 1"
        )
    ).fetchall()
    if duplicates:
        raise RuntimeError(
            "decision_subjects存在同逻辑身份多行，必须先人工核对："
            + ", ".join(
                f"{kind}/{resource}/{revision} x{count}" for kind, resource, revision, count in duplicates
            )
        )
    op.create_index(
        "uq_decision_subjects_identity",
        "decision_subjects",
        ["subject_kind", "resource_id", "resource_revision"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_decision_subjects_identity", table_name="decision_subjects")
