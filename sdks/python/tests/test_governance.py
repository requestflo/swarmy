"""Guardrails and policies: method, URL, JSON body and a decoded field per
route, against the mocked urllib opener of test_parity.py."""

import json

from test_parity import FakeResponse, check, make_client, page

GUARDRAILS = {
    "org_id": "org1",
    "production_safety_mode": True,
    "rules": [{"id": "minDbReplicasProd", "enabled": True, "severity": "block", "params": {"n": 3}, "prod_only": True}],
}


def test_guardrails_get():
    client, opener = make_client(GUARDRAILS)
    out = client.guardrails.get()
    check(opener.requests[0], "GET", "/guardrails")
    assert out.production_safety_mode is True and out.rules[0]["params"] == {"n": 3}


def test_guardrails_update():
    client, opener = make_client(dict(GUARDRAILS, production_safety_mode=False))
    out = client.guardrails.update(production_safety_mode=False, rules=[{"id": "requireHealthcheck", "enabled": True}])
    check(
        opener.requests[0],
        "PATCH",
        "/guardrails",
        {"production_safety_mode": False, "rules": [{"id": "requireHealthcheck", "enabled": True}]},
    )
    assert out.production_safety_mode is False


SOURCE = json.dumps({"roles": ["member"], "actions": ["service.restart"]})
POLICY = {
    "id": "p 1",
    "name": "Members restart",
    "description": None,
    "effect": "permit",
    "source": SOURCE,
    "priority": 0,
    "enabled": True,
    "is_default": False,
    "sentence": "Members can restart",
    "updated_at": "2026-10-01T00:00:00.000Z",
}


def test_policies_list_and_get():
    client, opener = make_client(page(POLICY), POLICY)
    policies, next_cursor = client.policies.list()
    check(opener.requests[0], "GET", "/policies")
    assert policies[0].effect == "permit" and next_cursor is None
    assert client.policies.get("p 1").sentence == "Members can restart"
    check(opener.requests[1], "GET", "/policies/p%201")


def test_policies_create_replace_remove():
    client, opener = make_client(FakeResponse(POLICY, status=201), dict(POLICY, enabled=False), {"id": "p1", "removed": True})
    client.policies.create("Members restart", "permit", SOURCE, priority=0)
    check(opener.requests[0], "POST", "/policies", {"name": "Members restart", "effect": "permit", "source": SOURCE, "priority": 0})
    assert client.policies.replace("p1", "Members restart", "permit", SOURCE, enabled=False).enabled is False
    check(opener.requests[1], "PUT", "/policies/p1", {"name": "Members restart", "effect": "permit", "source": SOURCE, "enabled": False})
    assert client.policies.remove("p1").removed is True
    check(opener.requests[2], "DELETE", "/policies/p1")
