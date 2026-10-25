"""Guardrails and policies: method, URL, JSON body and a decoded field per
route, against the mocked urllib opener of test_parity.py."""

from test_parity import check, make_client

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
