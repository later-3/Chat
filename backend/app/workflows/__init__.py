"""Product-facing MAF Workflow catalog and runtime adapters."""

from .catalog import (
    NESTED_QUALITY_WORKFLOW,
    WORKFLOW_CATALOG,
    WorkflowDefinition,
    workflow_catalog_view,
)
from .nested_demo import create_nested_quality_workflow
from .runtime import ProductAwareWorkflow

__all__ = [
    "NESTED_QUALITY_WORKFLOW",
    "ProductAwareWorkflow",
    "WORKFLOW_CATALOG",
    "WorkflowDefinition",
    "create_nested_quality_workflow",
    "workflow_catalog_view",
]
