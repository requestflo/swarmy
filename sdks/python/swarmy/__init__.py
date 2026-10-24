"""Official Python client for the swarmy public REST API."""

from __future__ import annotations

from .client import SwarmyClient
from .errors import SwarmyApiError
from .models import (
    DeploymentRef,
    IngressDomain,
    JoinToken,
    JoinTokenIssued,
    Node,
    Problem,
    Removed,
    Revoked,
    Service,
    ServiceReplicas,
    Stack,
    StackConnection,
    StackEndpoints,
)

__all__ = [
    "SwarmyClient",
    "SwarmyApiError",
    "Node",
    "Service",
    "ServiceReplicas",
    "Stack",
    "IngressDomain",
    "DeploymentRef",
    "Removed",
    "Revoked",
    "StackConnection",
    "StackEndpoints",
    "JoinToken",
    "JoinTokenIssued",
    "Problem",
]

__version__ = "0.1.0"
