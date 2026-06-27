"""Official Python client for the swarmy public REST API."""

from __future__ import annotations

from .client import SwarmyClient
from .errors import SwarmyApiError
from .models import (
    DeploymentRef,
    IngressDomain,
    Node,
    Problem,
    Removed,
    Service,
    ServiceReplicas,
    Stack,
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
    "Problem",
]

__version__ = "0.1.0"
