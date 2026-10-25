"""Top-level swarmy client (hand-written, stable)."""

from __future__ import annotations

from typing import Any, Dict, Optional

from ._http import HttpTransport
from .models import NotifyQueued, Principal
from .resources import (
    IngressResource,
    JoinTokensResource,
    NodesResource,
    ServicesResource,
    StacksResource,
    _compact,
)
from .resources_alerts import AlertRulesResource, NotificationChannelsResource
from .resources_governance import GuardrailsResource
from .resources_extra import (
    ApiKeysResource,
    AppsResource,
    AuditResource,
    BackupsResource,
    DeploymentsResource,
    DnsResource,
    GitResource,
    RegistryCredentialsResource,
    VolumesResource,
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
        self.join_tokens = JoinTokensResource(self._http)
        self.api_keys = ApiKeysResource(self._http)
        self.dns = DnsResource(self._http)
        self.backups = BackupsResource(self._http)
        self.volumes = VolumesResource(self._http)
        self.audit = AuditResource(self._http)
        self.registry_credentials = RegistryCredentialsResource(self._http)
        self.git = GitResource(self._http)
        self.apps = AppsResource(self._http)
        self.deployments = DeploymentsResource(self._http)
        self.alert_rules = AlertRulesResource(self._http)
        self.notification_channels = NotificationChannelsResource(self._http)
        self.guardrails = GuardrailsResource(self._http)

    def me(self) -> Principal:
        """Who this credential acts as (org, user, role) and its scopes."""
        return Principal.from_dict(self._http.request("GET", "/me"))

    def notify(
        self,
        to: str,
        subject: str,
        body: Optional[str] = None,
        html: Optional[str] = None,
        template: Optional[str] = None,
        vars: Optional[Dict[str, Any]] = None,
    ) -> NotifyQueued:
        """Send an email through the org's Email service (queued, 202): a plain
        ``body`` and/or ``html``, or a ``template`` filled with ``vars``."""
        payload = _compact(
            {"to": to, "subject": subject, "body": body, "html": html, "template": template, "vars": vars}
        )
        return NotifyQueued.from_dict(self._http.request("POST", "/notify", body=payload))

    def __repr__(self) -> str:
        return "SwarmyClient(endpoint={!r})".format(self._http.base)
