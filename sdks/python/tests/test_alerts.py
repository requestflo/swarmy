"""Alert rules and notification channels: method, URL, JSON body and a decoded
field per route, against the mocked urllib opener of test_parity.py."""

from test_parity import FakeResponse, check, make_client, page

RULE = {
    "id": "ar 1",
    "name": "Disk",
    "signal": "disk-usage",
    "selector": {"server": "wkr-1"},
    "threshold": 90.5,
    "for_seconds": 300,
    "channel_ids": ["ch1"],
    "enabled": True,
    "is_default": False,
    "muted_until": None,
    "created_at": "2026-10-01T00:00:00.000Z",
}
CHANNEL = {
    "id": "ch1",
    "name": "ops",
    "kind": "slack",
    "enabled": True,
    "target": "hooks.slack.com",
    "has_secret": False,
    "created_at": "2026-10-01T00:00:00.000Z",
}


def test_alert_rules_list_and_get():
    client, opener = make_client(page(RULE), RULE)
    rules, next_cursor = client.alert_rules.list()
    check(opener.requests[0], "GET", "/alert-rules")
    assert rules[0].threshold == 90.5 and next_cursor is None
    assert client.alert_rules.get("ar 1").selector == {"server": "wkr-1"}
    check(opener.requests[1], "GET", "/alert-rules/ar%201")


def test_alert_rules_create():
    client, opener = make_client(FakeResponse(RULE, status=201))
    out = client.alert_rules.create("Disk", "disk-usage", selector={"server": "wkr-1"}, threshold=90.5, enabled=False)
    check(
        opener.requests[0],
        "POST",
        "/alert-rules",
        {"name": "Disk", "signal": "disk-usage", "selector": {"server": "wkr-1"}, "threshold": 90.5, "enabled": False},
    )
    assert out.id == "ar 1"


def test_alert_rules_update_clears_threshold_and_remove():
    client, opener = make_client(dict(RULE, threshold=None), {"id": "ar1", "removed": True})
    assert client.alert_rules.update("ar1", threshold=None, channel_ids=[]).threshold is None
    check(opener.requests[0], "PATCH", "/alert-rules/ar1", {"channel_ids": [], "threshold": None})
    assert client.alert_rules.remove("ar1").removed is True
    check(opener.requests[1], "DELETE", "/alert-rules/ar1")


def test_notification_channels_list_get_create():
    client, opener = make_client(page(CHANNEL), CHANNEL, FakeResponse(CHANNEL, status=201))
    channels, _ = client.notification_channels.list()
    check(opener.requests[0], "GET", "/notification-channels")
    assert channels[0].target == "hooks.slack.com"
    assert client.notification_channels.get("ch 1").kind == "slack"
    check(opener.requests[1], "GET", "/notification-channels/ch%201")
    client.notification_channels.create("ops", {"kind": "slack", "url": "https://hooks.slack.com/x"})
    check(
        opener.requests[2],
        "POST",
        "/notification-channels",
        {"name": "ops", "config": {"kind": "slack", "url": "https://hooks.slack.com/x"}},
    )


def test_notification_channels_update_and_remove():
    client, opener = make_client(dict(CHANNEL, enabled=False), {"id": "ch1", "removed": True})
    assert client.notification_channels.update("ch1", enabled=False).enabled is False
    check(opener.requests[0], "PATCH", "/notification-channels/ch1", {"enabled": False})
    assert client.notification_channels.remove("ch1").removed is True
    check(opener.requests[1], "DELETE", "/notification-channels/ch1")
