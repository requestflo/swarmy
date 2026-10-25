"""Guardrails and access policies (hand-written, stable)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from ._http import HttpTransport
from .models import Guardrails, Policy, Removed
from .resources import _compact, _quote


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


class PoliciesResource:
    """ABAC access policies. Writes need ``policy.write`` (owners and admins by default)."""

    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def list(self) -> Tuple[List[Policy], Optional[str]]:
        """Every policy, highest priority first (the defaults are seeded)."""
        body = self._http.request("GET", "/policies")
        return [Policy.from_dict(x) for x in body["data"]], body.get("next_cursor")

    def get(self, policy_id: str) -> Policy:
        return Policy.from_dict(self._http.request("GET", "/policies/{}".format(_quote(policy_id))))

    def create(
        self,
        name: str,
        effect: str,
        source: str,
        description: Optional[str] = None,
        priority: Optional[int] = None,
        enabled: Optional[bool] = None,
    ) -> Policy:
        """Add a policy. ``source`` is the JSON document (``json.dumps({...})``); it is validated first."""
        payload = _policy(name, effect, source, description, priority, enabled)
        return Policy.from_dict(self._http.request("POST", "/policies", body=payload))

    def replace(
        self,
        policy_id: str,
        name: str,
        effect: str,
        source: str,
        description: Optional[str] = None,
        priority: Optional[int] = None,
        enabled: Optional[bool] = None,
    ) -> Policy:
        """Replace a policy (a seeded default may only be switched on or off)."""
        payload = _policy(name, effect, source, description, priority, enabled)
        return Policy.from_dict(
            self._http.request("PUT", "/policies/{}".format(_quote(policy_id)), body=payload)
        )

    def remove(self, policy_id: str) -> Removed:
        """Delete a custom policy (defaults cannot be deleted)."""
        return Removed.from_dict(self._http.request("DELETE", "/policies/{}".format(_quote(policy_id))))


def _policy(
    name: str, effect: str, source: str, description: Optional[str], priority: Optional[int], enabled: Optional[bool]
) -> Dict[str, Any]:
    return _compact(
        {
            "name": name,
            "description": description,
            "effect": effect,
            "source": source,
            "priority": priority,
            "enabled": enabled,
        }
    )
