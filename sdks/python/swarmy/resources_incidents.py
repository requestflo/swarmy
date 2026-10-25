"""Incidents and the alert events behind them (hand-written, stable)."""

from __future__ import annotations

from typing import List, Optional, Tuple

from ._http import HttpTransport
from .models import AlertEvent, Incident, IncidentDetail
from .resources import _compact, _quote


class IncidentsResource:
    """Incidents: read the story, resolve it."""

    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def list(self, status: Optional[str] = None, limit: Optional[int] = None) -> Tuple[List[Incident], Optional[str]]:
        """Incidents, open first then newest; ``status`` is ``"open"`` or ``"resolved"``."""
        body = self._http.request("GET", "/incidents", query={"status": status, "limit": limit})
        return [Incident.from_dict(x) for x in body["data"]], body.get("next_cursor")

    def get(self, incident_id: str) -> IncidentDetail:
        """One incident with its timeline (``events``, oldest first)."""
        return IncidentDetail.from_dict(self._http.request("GET", "/incidents/{}".format(_quote(incident_id))))

    def resolve(self, incident_id: str, message: Optional[str] = None) -> IncidentDetail:
        """Resolve an open incident; ``message`` goes on its timeline."""
        return IncidentDetail.from_dict(
            self._http.request(
                "POST", "/incidents/{}/resolve".format(_quote(incident_id)), body=_compact({"message": message})
            )
        )


class AlertEventsResource:
    """Alert events: the firing/resolved feed."""

    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def list(self, status: Optional[str] = None, limit: Optional[int] = None) -> Tuple[List[AlertEvent], Optional[str]]:
        """Events, newest first; ``status`` is ``"firing"`` or ``"resolved"``."""
        body = self._http.request("GET", "/alert-events", query={"status": status, "limit": limit})
        return [AlertEvent.from_dict(x) for x in body["data"]], body.get("next_cursor")

    def acknowledge(self, event_id: str) -> AlertEvent:
        """Acknowledge (manually resolve) a firing event; no recovery notification is sent."""
        return AlertEvent.from_dict(
            self._http.request("POST", "/alert-events/{}/acknowledge".format(_quote(event_id)))
        )
