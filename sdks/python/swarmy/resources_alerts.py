"""Alert rules and notification channels (hand-written, stable)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from ._http import HttpTransport
from .models import AlertRule, NotificationChannel, Removed
from .resources import _UNSET, _compact, _quote


def _page(body: Dict[str, Any], model: Any) -> Tuple[List[Any], Optional[str]]:
    return [model.from_dict(x) for x in body["data"]], body.get("next_cursor")


class AlertRulesResource:
    """Alert rules: several per signal, each narrowed by its own target."""

    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def list(self) -> Tuple[List[AlertRule], Optional[str]]:
        """Every rule (the per-signal defaults are seeded on first call)."""
        return _page(self._http.request("GET", "/alert-rules"), AlertRule)

    def get(self, rule_id: str) -> AlertRule:
        return AlertRule.from_dict(self._http.request("GET", "/alert-rules/{}".format(_quote(rule_id))))

    def create(
        self,
        name: str,
        signal: str,
        selector: Optional[Dict[str, str]] = None,
        threshold: Optional[float] = None,
        for_seconds: Optional[int] = None,
        channel_ids: Optional[List[str]] = None,
        enabled: Optional[bool] = None,
    ) -> AlertRule:
        """Add a rule for ``signal``, optionally narrowed by ``selector``
        (``{"app": …, "service": …}`` or ``{"server": …}``)."""
        payload = _compact(
            {
                "name": name,
                "signal": signal,
                "selector": selector,
                "threshold": threshold,
                "for_seconds": for_seconds,
                "channel_ids": channel_ids,
                "enabled": enabled,
            }
        )
        return AlertRule.from_dict(self._http.request("POST", "/alert-rules", body=payload))

    def update(
        self,
        rule_id: str,
        name: Optional[str] = None,
        selector: Optional[Dict[str, str]] = None,
        threshold: Any = _UNSET,
        for_seconds: Optional[int] = None,
        channel_ids: Optional[List[str]] = None,
        enabled: Optional[bool] = None,
    ) -> AlertRule:
        """Change the fields given; the rest keep their value. ``threshold=None``
        clears it, ``selector={}`` widens the rule to any subject."""
        payload = _compact(
            {"name": name, "selector": selector, "for_seconds": for_seconds, "channel_ids": channel_ids, "enabled": enabled}
        )
        if threshold is not _UNSET:
            payload["threshold"] = threshold
        return AlertRule.from_dict(
            self._http.request("PATCH", "/alert-rules/{}".format(_quote(rule_id)), body=payload)
        )

    def remove(self, rule_id: str) -> Removed:
        """Delete a rule; a seeded default is opted out and never re-created."""
        return Removed.from_dict(self._http.request("DELETE", "/alert-rules/{}".format(_quote(rule_id))))


class NotificationChannelsResource:
    """Notification channels. The destination (``config``) is write-only."""

    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def list(self) -> Tuple[List[NotificationChannel], Optional[str]]:
        return _page(self._http.request("GET", "/notification-channels"), NotificationChannel)

    def get(self, channel_id: str) -> NotificationChannel:
        return NotificationChannel.from_dict(
            self._http.request("GET", "/notification-channels/{}".format(_quote(channel_id)))
        )

    def create(self, name: str, config: Dict[str, Any]) -> NotificationChannel:
        """Add a channel (it starts enabled). ``config`` is the destination, e.g.
        ``{"kind": "slack", "url": "https://hooks.slack.com/…"}``."""
        payload = {"name": name, "config": config}
        return NotificationChannel.from_dict(self._http.request("POST", "/notification-channels", body=payload))

    def update(
        self,
        channel_id: str,
        name: Optional[str] = None,
        enabled: Optional[bool] = None,
        config: Optional[Dict[str, Any]] = None,
    ) -> NotificationChannel:
        """Rename, enable/disable, or repoint (same kind only) a channel."""
        payload = _compact({"name": name, "enabled": enabled, "config": config})
        return NotificationChannel.from_dict(
            self._http.request("PATCH", "/notification-channels/{}".format(_quote(channel_id)), body=payload)
        )

    def remove(self, channel_id: str) -> Removed:
        return Removed.from_dict(
            self._http.request("DELETE", "/notification-channels/{}".format(_quote(channel_id)))
        )
