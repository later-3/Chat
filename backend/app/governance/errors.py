"""Stable application errors for execution governance."""


class GovernanceError(ValueError):
    code = "GOVERNANCE_INVALID"


class GovernanceValidationError(GovernanceError):
    code = "GOVERNANCE_VALIDATION_FAILED"


class GovernanceConflict(GovernanceError):
    code = "GOVERNANCE_CONFLICT"
