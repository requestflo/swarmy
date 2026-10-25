"""Guardrails and access policies (hand-written, stable)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from ._http import HttpTransport
from .models import Guardrails
from .resources import _compact


class GuardrailsResource:
    """The org's guardrails: production safety mode and the deploy rules (one per org)."""

    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def get(self) -> Guardrails:
        """The guardrails (seeded with the defaults on first read)."""
        return Guardrails.from_dict(self._http.request("GET", "/guardrails"))

    def update(
        self,
        production_safety_mode: Optional[bool] = None,
        rules: Optional[List[Dict[str, Any]]] = None,
    ) -> Guardrails:
        """Change the switch and/or the rules named (admins and owners), e.g.
        ``rules=[{"id": "requireHealthcheck", "enabled": True}]``; the rest keep their state."""
        payload = _compact({"production_safety_mode": production_safety_mode, "rules": rules})
        return Guardrails.from_dict(self._http.request("PATCH", "/guardrails", body=payload))
