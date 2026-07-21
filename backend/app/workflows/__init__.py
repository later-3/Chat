"""Product-facing MAF Workflow catalog and runtime adapters."""

from .catalog import (
    GOVERNED_AGENT_HANDOFF_WORKFLOW,
    NESTED_QUALITY_WORKFLOW,
    WORKFLOW_CATALOG,
    WorkflowDefinition,
    workflow_catalog_view,
)
from .multi_agent import create_governed_agent_handoff_workflow
from .nested_demo import create_nested_quality_workflow
from .runtime import ProductAwareWorkflow

__all__ = [
    "NESTED_QUALITY_WORKFLOW",
    "GOVERNED_AGENT_HANDOFF_WORKFLOW",
    "ProductAwareWorkflow",
    "WORKFLOW_CATALOG",
    "WorkflowDefinition",
    "create_nested_quality_workflow",
    "create_governed_agent_handoff_workflow",
    "workflow_catalog_view",
]
