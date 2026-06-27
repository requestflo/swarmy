"""Top-level swarmy client (hand-written, stable)."""

from __future__ import annotations

from typing import Any, Dict, Optional

from ._http import HttpTransport
from .resources import (
    IngressResource,
    NodesResource,
    ServicesResource,
    StacksResource,
)


class SwarmyClient:
    """Official client for the swarmy public REST API.

    >>> c = SwarmyClient("https://swarm.example.com", "swk_...")
    >>> services, next_cursor = c.services.list()
    >>> for svc in c.services.iterate():
    ...     print(svc.name)
    """

    def __init__(
        self,
        endpoint: str,
        api_key: str,
        opener: Optional[Any] = None,
        timeout: float = 30.0,
        headers: Optional[Dict[str, str]] = None,
    ) -> None:
        self._http = HttpTransport(endpoint, api_key, opener=opener, timeout=timeout, headers=headers)
        self.services = ServicesResource(self._http)
        self.stacks = StacksResource(self._http)
        self.nodes = NodesResource(self._http)
        self.ingress = IngressResource(self._http)

    def __repr__(self) -> str:
        return "SwarmyClient(endpoint={!r})".format(self._http.base)
