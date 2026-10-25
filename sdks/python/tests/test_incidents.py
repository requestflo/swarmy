"""Incidents and alert events: method, URL, JSON body and a decoded field per
route, against the mocked urllib opener of test_parity.py."""

from test_parity import check, make_client, page

INCIDENT = {
    "id": "inc 1",
    "title": "Shop is down",
    "status": "open",
    "severity": "critical",
    "summary": None,
    "opened_at": "2026-10-01T00:00:00.000Z",
    "resolved_at": None,
    "duration_sec": 60,
    "event_count": 1,
    "last_event_at": None,
}
DETAIL = dict(INCIDENT, events=[{"id": "e1", "at": "2026-10-01T00:00:00.000Z", "kind": "opened", "message": "m", "meta": {}}])
EVENT = {
    "id": "ae1",
    "rule_id": "ar1",
    "rule_name": "Shop down",
    "signal": "service-down",
    "severity": "critical",
    "resource": "shop",
    "message": "down",
    "status": "resolved",
    "notify": "sent",
    "fired_at": "2026-10-01T00:00:00.000Z",
    "resolved_at": None,
}


def test_incidents_list_get_resolve():
    client, opener = make_client(page(INCIDENT), DETAIL, dict(DETAIL, status="resolved"))
    incidents, _ = client.incidents.list(status="open", limit=10)
    check(opener.requests[0], "GET", "/incidents?status=open&limit=10")
    assert incidents[0].severity == "critical"
    assert client.incidents.get("inc 1").events[0]["kind"] == "opened"
    check(opener.requests[1], "GET", "/incidents/inc%201")
    assert client.incidents.resolve("inc1", message="Rolled back").status == "resolved"
    check(opener.requests[2], "POST", "/incidents/inc1/resolve", {"message": "Rolled back"})


def test_alert_events_list_and_acknowledge():
    client, opener = make_client(page(EVENT), EVENT)
    events, _ = client.alert_events.list()
    check(opener.requests[0], "GET", "/alert-events")
    assert events[0].rule_name == "Shop down"
    assert client.alert_events.acknowledge("ae1").status == "resolved"
    check(opener.requests[1], "POST", "/alert-events/ae1/acknowledge")
