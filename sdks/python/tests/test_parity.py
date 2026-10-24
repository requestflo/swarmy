"""One test per REST route the SDK gained for parity with the spec: each asserts
the method, URL, JSON body (when there is one) and a decoded field, against
the same mocked urllib opener as test_client.py."""

import io
import json

import pytest

import swarmy

BASE = "https://swarm.example.com/api/v1"
NO_BODY = object()


class FakeResponse:
    def __init__(self, body, status=200, headers=None):
        raw = body if isinstance(body, bytes) else (body if isinstance(body, str) else json.dumps(body)).encode("utf-8")
        self._buf = io.BytesIO(raw)
        self.status = status
        self.headers = headers or {"Content-Type": "application/json"}
        self.closed = False

    def read(self):
        return self._buf.read()

    def readline(self):
        return self._buf.readline()

    def close(self):
        self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class MockOpener:
    def __init__(self, responses):
        self._responses = list(responses)
        self.requests = []
        self.timeouts = []

    def open(self, req, timeout=None):
        self.requests.append(req)
        self.timeouts.append(timeout)
        return self._responses.pop(0)


def make_client(*responses):
    opener = MockOpener([r if isinstance(r, FakeResponse) else FakeResponse(r) for r in responses])
    return swarmy.SwarmyClient("https://swarm.example.com/", "swk_test", opener=opener), opener


def check(req, method, path, body=NO_BODY):
    assert req.get_method() == method
    assert req.full_url == BASE + path
    assert req.headers["Authorization"] == "Bearer swk_test"
    if body is NO_BODY:
        assert req.data is None
    else:
        assert json.loads(req.data.decode("utf-8")) == body


def page(*items):
    return {"data": list(items), "next_cursor": None}


# --- client --------------------------------------------------------------------------------------


def test_me():
    client, opener = make_client({"org_id": "o1", "user": {"id": "u1"}, "role": "admin", "credential": {"kind": "api_key"}})
    me = client.me()
    check(opener.requests[0], "GET", "/me")
    assert me.org_id == "o1" and me.role == "admin"


def test_notify():
    client, opener = make_client(FakeResponse({"queued": True, "to": "a@x.io"}, status=202))
    out = client.notify("a@x.io", "Hi", body="hello")
    check(opener.requests[0], "POST", "/notify", {"to": "a@x.io", "subject": "Hi", "body": "hello"})
    assert out.queued is True


# --- services ------------------------------------------------------------------------------------


def test_services_env():
    env = {"service_id": "s1", "service": "web", "vars": [{"key": "A", "value": None, "secret": True}], "secrets_readable": False}
    client, opener = make_client(env, env)
    assert client.services.env("s 1").service == "web"
    check(opener.requests[0], "GET", "/services/s%201/env")
    client.services.env("s1", reveal_secrets=True)
    check(opener.requests[1], "GET", "/services/s1/env?reveal_secrets=true")


def test_services_patch_env():
    client, opener = make_client(FakeResponse({"id": "s1", "deployment_id": "d1", "changed": ["A"]}, status=202))
    out = client.services.patch_env("s1", set={"A": "1"}, unset=["B"])
    check(opener.requests[0], "PATCH", "/services/s1/env", {"set": {"A": "1"}, "unset": ["B"]})
    assert out.changed == ["A"]


def test_services_logs():
    client, opener = make_client(page({"seq": 1, "stream": "stdout", "ts": 1.5, "message": "up"}))
    lines, next_cursor = client.services.logs("s1", tail=50)
    check(opener.requests[0], "GET", "/services/s1/logs?tail=50")
    assert [l.message for l in lines] == ["up"] and next_cursor is None


def test_services_follow_logs_reads_sse_and_skips_malformed_events():
    sse = (
        'data: {"seq":1,"stream":"stdout","ts":null,"message":"a"}\n\n'
        ": keepalive\n\n"
        "data: not json\n\n"
        'data: {"seq":2,"stream":"stderr","ts":null,"message":"b"}\n'
    )
    resp = FakeResponse(sse, headers={"Content-Type": "text/event-stream"})
    client, opener = make_client(resp)
    lines = list(client.services.follow_logs("s1", tail=10))
    req = opener.requests[0]
    check(req, "GET", "/services/s1/logs/stream?tail=10")
    assert req.headers["Accept"] == "text/event-stream"
    assert opener.timeouts == [None]
    assert [(l.seq, l.message) for l in lines] == [(1, "a"), (2, "b")]
    assert resp.closed


# --- stacks --------------------------------------------------------------------------------------


def test_stacks_telemetry_and_set_telemetry():
    client, opener = make_client({"stack": "shop", "enabled": False}, {"stack": "shop", "enabled": False})
    assert client.stacks.telemetry("shop").enabled is False
    check(opener.requests[0], "GET", "/stacks/shop/telemetry")
    client.stacks.set_telemetry("shop", False)
    check(opener.requests[1], "PUT", "/stacks/shop/telemetry", {"enabled": False})


def test_stacks_errors():
    client, opener = make_client({"stack": "shop", "enabled": True, "store_enabled": True, "project": {}, "pending_redeploy": []})
    assert client.stacks.errors("shop").enabled is True
    check(opener.requests[0], "GET", "/stacks/shop/errors")


def test_stacks_rotate_errors_key():
    client, opener = make_client({"stack": "shop", "project_id": 7, "dsn": "https://k@x/7"})
    assert client.stacks.rotate_errors_key("shop").dsn == "https://k@x/7"
    check(opener.requests[0], "POST", "/stacks/shop/errors/rotate-key")


# --- nodes ---------------------------------------------------------------------------------------


def test_nodes_remove():
    client, opener = make_client({"id": "n1", "removed": True})
    assert client.nodes.remove("n1").removed is True
    check(opener.requests[0], "DELETE", "/nodes/n1")


def test_nodes_drain_and_uncordon():
    client, opener = make_client({"id": "n1", "availability": "drain"}, {"id": "n1", "availability": "active"})
    assert client.nodes.drain("n1").availability == "drain"
    check(opener.requests[0], "POST", "/nodes/n1/drain")
    assert client.nodes.uncordon("n1").availability == "active"
    check(opener.requests[1], "POST", "/nodes/n1/uncordon")


def test_nodes_set_labels():
    client, opener = make_client({"id": "n1", "labels": {"zone": "a"}})
    assert client.nodes.set_labels("n1", {"zone": "a"}).labels == {"zone": "a"}
    check(opener.requests[0], "PUT", "/nodes/n1/labels", {"labels": {"zone": "a"}})


# --- ingress -------------------------------------------------------------------------------------


def test_ingress_update_domain_sends_null_to_clear():
    client, opener = make_client({"id": "d1", "host": "x.io", "www": None}, {"id": "d1", "host": "x.io", "www": "serve-both"})
    client.ingress.update_domain("d1", None)
    check(opener.requests[0], "PATCH", "/ingress/domains/d1", {"www": None})
    assert client.ingress.update_domain("d1", "serve-both").www == "serve-both"
    check(opener.requests[1], "PATCH", "/ingress/domains/d1", {"www": "serve-both"})


def test_ingress_add_domain_www():
    client, opener = make_client(FakeResponse({"id": "d1", "host": "x.io"}, status=201))
    client.ingress.add_domain("x.io", "s1", 80, www="redirect-www-to-apex")
    check(opener.requests[0], "POST", "/ingress/domains", {"host": "x.io", "service_id": "s1", "target_port": 80, "www": "redirect-www-to-apex"})


def test_ingress_domain_status_and_verify():
    detail = {
        "host": "x.io", "state": "live", "reason": "ok", "warnings": [], "gated": False,
        "guidance": {"mode": "records", "summary": "point A", "records": [], "alternatives": []},
        "companion": {"host": "www.x.io", "state": "pending"},
    }
    client, opener = make_client(detail, detail)
    st = client.ingress.domain_status("d1")
    check(opener.requests[0], "GET", "/ingress/domains/d1/status")
    assert isinstance(st, swarmy.IngressDomainDetail)
    assert st.state == "live" and st.guidance.mode == "records" and st.companion["host"] == "www.x.io"
    assert client.ingress.verify_domain("d1").host == "x.io"
    check(opener.requests[1], "POST", "/ingress/domains/d1/verify")


def test_ingress_settings():
    client, opener = make_client({"org_id": "o1", "driver": "caddy", "enabled": True, "topology": "controller"})
    assert client.ingress.settings().driver == "caddy"
    check(opener.requests[0], "GET", "/ingress/settings")


def test_ingress_update_settings_sends_false_and_null_only_when_given():
    settings = {"org_id": "o1", "driver": "caddy", "enabled": False, "tunnel": None}
    client, opener = make_client(settings, settings)
    assert client.ingress.update_settings(enabled=False).enabled is False
    check(opener.requests[0], "PUT", "/ingress/settings", {"enabled": False})
    client.ingress.update_settings(tunnel=None, tls={"on_demand": False})
    check(opener.requests[1], "PUT", "/ingress/settings", {"tunnel": None, "tls": {"on_demand": False}})


# --- api keys ------------------------------------------------------------------------------------


def test_api_keys_list():
    client, opener = make_client(page({"id": "k1", "name": "ci", "prefix": "ab12", "status": "active"}))
    keys, next_cursor = client.api_keys.list()
    check(opener.requests[0], "GET", "/api-keys")
    assert keys[0].prefix == "ab12" and not hasattr(keys[0], "key")


def test_api_keys_create_returns_the_plaintext_once():
    client, opener = make_client(FakeResponse({"id": "k1", "name": "ci", "prefix": "ab12", "key": "swk_ab12_s"}, status=201))
    issued = client.api_keys.create("ci", preset="deploy", stack_names=["shop"])
    check(opener.requests[0], "POST", "/api-keys", {"name": "ci", "preset": "deploy", "stack_names": ["shop"]})
    assert isinstance(issued, swarmy.ApiKeyIssued) and issued.key == "swk_ab12_s" and issued.name == "ci"


def test_api_keys_revoke():
    client, opener = make_client({"id": "k1", "revoked": True})
    assert client.api_keys.revoke("k1").revoked is True
    check(opener.requests[0], "DELETE", "/api-keys/k1")


# --- dns -----------------------------------------------------------------------------------------


def test_dns_zones():
    zone = {"id": "z1", "zone": "x.io", "mode": "swarmy-ns"}
    client, opener = make_client(page(zone), zone, {"id": "z1", "removed": True})
    zones, _ = client.dns.list_zones()
    check(opener.requests[0], "GET", "/dns/zones")
    assert zones[0].zone == "x.io"
    assert client.dns.create_zone("x.io").id == "z1"
    check(opener.requests[1], "POST", "/dns/zones", {"zone": "x.io"})
    assert client.dns.remove_zone("z1").removed is True
    check(opener.requests[2], "DELETE", "/dns/zones/z1")


def test_dns_delegation():
    client, opener = make_client({"zone": "x.io", "delegated": True, "public_ns": [], "nameservers": []})
    assert client.dns.delegation("z1").delegated is True
    check(opener.requests[0], "GET", "/dns/zones/z1/delegation")


def test_dns_records():
    rec = {"id": "r1", "zone_id": "z1", "name": "@", "type": "MX", "value": "mx.x.io", "ttl": None, "priority": 0}
    client, opener = make_client(page(rec), rec, {"id": "r1", "removed": True})
    records, _ = client.dns.list_records("z1")
    check(opener.requests[0], "GET", "/dns/zones/z1/records")
    assert records[0].type == "MX"
    assert client.dns.upsert_record("z1", "@", "MX", "mx.x.io", priority=0).priority == 0
    check(opener.requests[1], "POST", "/dns/zones/z1/records", {"name": "@", "type": "MX", "value": "mx.x.io", "priority": 0})
    assert client.dns.remove_record("r1").removed is True
    check(opener.requests[2], "DELETE", "/dns/records/r1")


# --- backups + volumes ---------------------------------------------------------------------------


def test_backup_targets():
    target = {"id": "t1", "name": "s3", "kind": "s3", "bucket": "b"}
    client, opener = make_client(page(target), FakeResponse(target, status=201), {"id": "t1", "removed": True})
    targets, _ = client.backups.list_targets()
    check(opener.requests[0], "GET", "/backup-targets")
    assert targets[0].bucket == "b"
    assert client.backups.add_target("s3", "s3", "b", region="eu").id == "t1"
    check(opener.requests[1], "POST", "/backup-targets", {"name": "s3", "kind": "s3", "bucket": "b", "region": "eu"})
    assert client.backups.remove_target("t1").removed is True
    check(opener.requests[2], "DELETE", "/backup-targets/t1")


def test_snapshots():
    client, opener = make_client(
        page({"id": "sn1", "volume": "data", "status": "ok"}),
        FakeResponse({"snapshot_id": "sn2", "restic_id": "abc", "size_bytes": "10"}, status=201),
        {"target_volume": "data2", "bytes_restored": "10"},
    )
    snaps, _ = client.backups.list_snapshots(volume="data", target_id="t1")
    check(opener.requests[0], "GET", "/snapshots?volume=data&target_id=t1")
    assert snaps[0].id == "sn1"
    assert client.backups.backup_volume("t1", "data").snapshot_id == "sn2"
    check(opener.requests[1], "POST", "/snapshots", {"target_id": "t1", "volume": "data"})
    assert client.backups.restore_snapshot("sn2", target_volume="data2").target_volume == "data2"
    check(opener.requests[2], "POST", "/snapshots/restore", {"snapshot_id": "sn2", "target_volume": "data2"})


def test_volumes():
    vol = {"id": "v1", "name": "pg", "csi_driver": "x", "access_mode": "single-writer", "status": "ready"}
    client, opener = make_client(page(vol), FakeResponse(vol, status=201), {"id": "v1", "removed": True})
    vols, _ = client.volumes.list()
    check(opener.requests[0], "GET", "/volumes")
    assert vols[0].name == "pg"
    assert client.volumes.register("pg", "x", capacity_bytes=0).status == "ready"
    check(opener.requests[1], "POST", "/volumes", {"name": "pg", "csi_driver": "x", "capacity_bytes": 0})
    assert client.volumes.remove("v1").removed is True
    check(opener.requests[2], "DELETE", "/volumes/v1")


# --- audit ---------------------------------------------------------------------------------------


def test_audit_export_returns_the_body_and_row_headers():
    resp = FakeResponse(
        "at,action\n2026-10-01,secrets.read\n",
        headers={"content-type": "text/csv; charset=utf-8", "x-swarmy-row-count": "1", "x-swarmy-truncated": "true"},
    )
    client, opener = make_client(resp)
    out = client.audit.export(action="secrets.", from_="2026-10-01", format="csv")
    check(opener.requests[0], "GET", "/audit/export?action=secrets.&from=2026-10-01&format=csv")
    assert "text/csv" in opener.requests[0].headers["Accept"]
    assert isinstance(out, swarmy.AuditExport)
    assert out.content.startswith("at,action") and out.content_type.startswith("text/csv")
    assert out.row_count == 1 and out.truncated is True


# --- registry credentials ------------------------------------------------------------------------


def test_registry_credentials_list_and_create():
    cred = {"id": "c1", "prefix": "ghcr.io/acme", "provider": "ghcr", "label": None, "username": "bot", "has_secret": True}
    client, opener = make_client(page(cred), FakeResponse(cred, status=201))
    creds, _ = client.registry_credentials.list()
    check(opener.requests[0], "GET", "/registry-credentials")
    assert creds[0].prefix == "ghcr.io/acme"
    assert client.registry_credentials.create("ghcr.io/acme", "bot", "s3cret").username == "bot"
    check(opener.requests[1], "POST", "/registry-credentials", {"prefix": "ghcr.io/acme", "username": "bot", "secret": "s3cret"})


def test_registry_credentials_update_keeps_label_unless_given():
    cred = {"id": "c1", "username": "bot2", "label": None}
    client, opener = make_client(cred, cred)
    assert client.registry_credentials.update("c1", username="bot2").username == "bot2"
    check(opener.requests[0], "PATCH", "/registry-credentials/c1", {"username": "bot2"})
    client.registry_credentials.update("c1", label=None)
    check(opener.requests[1], "PATCH", "/registry-credentials/c1", {"label": None})


def test_registry_credentials_remove_and_test():
    client, opener = make_client({"ok": True}, {"ok": True, "status": "ok", "message": "", "checked_manifest": True})
    assert client.registry_credentials.remove("c1").ok is True
    check(opener.requests[0], "DELETE", "/registry-credentials/c1")
    assert client.registry_credentials.test("c1", image="ghcr.io/acme/web:1").checked_manifest is True
    check(opener.requests[1], "POST", "/registry-credentials/c1/test", {"image": "ghcr.io/acme/web:1"})


# --- git -----------------------------------------------------------------------------------------


def test_git_connections():
    conn = {"id": "gc1", "kind": "gitea", "display_name": "Gitea", "base_url": "https://git.x.io"}
    client, opener = make_client(page(conn), conn, FakeResponse(conn, status=201), {"id": "gc1", "removed": True})
    conns, _ = client.git.list_connections()
    check(opener.requests[0], "GET", "/git/connections")
    assert conns[0].kind == "gitea"
    assert client.git.get_connection("gc1").base_url == "https://git.x.io"
    check(opener.requests[1], "GET", "/git/connections/gc1")
    client.git.create_connection("gitea", base_url="https://git.x.io", token="t")
    check(opener.requests[2], "POST", "/git/connections", {"kind": "gitea", "base_url": "https://git.x.io", "token": "t"})
    assert client.git.remove_connection("gc1").removed is True
    check(opener.requests[3], "DELETE", "/git/connections/gc1")


def test_git_provider_repos_and_branches():
    client, opener = make_client(
        page({"id": "1", "full_name": "acme/web", "private": True}), page({"name": "main", "sha": "abc"})
    )
    repos, _ = client.git.list_provider_repos("gc1", search="web")
    check(opener.requests[0], "GET", "/git/connections/gc1/repos?search=web")
    assert repos[0].full_name == "acme/web"
    branches, _ = client.git.list_provider_branches("gc1", "acme/web")
    check(opener.requests[1], "GET", "/git/connections/gc1/branches?repo=acme%2Fweb")
    assert branches[0].name == "main"


def test_git_repos():
    repo = {"id": "r1", "url": "https://x.dev/a.git", "branch": "main", "config_path": "swarmy.yaml"}
    linked = {**repo, "full_name": None, "webhook": {"url": "https://h", "secret": "whs"}, "deploy_key_public": None}
    client, opener = make_client(
        page(repo), repo, FakeResponse(linked, status=201), {**repo, "branch": "dev"}, {"id": "r1", "removed": True}
    )
    repos, _ = client.git.list_repos()
    check(opener.requests[0], "GET", "/git/repos")
    assert repos[0].branch == "main"
    assert client.git.get_repo("r1").id == "r1"
    check(opener.requests[1], "GET", "/git/repos/r1")
    out = client.git.link_repo("main", url="https://x.dev/a.git", deploy_key=False)
    check(opener.requests[2], "POST", "/git/repos", {"url": "https://x.dev/a.git", "branch": "main", "deploy_key": False})
    assert out.webhook.secret == "whs"
    assert client.git.update_repo("r1", branch="dev").branch == "dev"
    check(opener.requests[3], "PATCH", "/git/repos/r1", {"branch": "dev"})
    assert client.git.remove_repo("r1").removed is True
    check(opener.requests[4], "DELETE", "/git/repos/r1")


# --- apps ----------------------------------------------------------------------------------------

APP = {"repo_id": "gr1", "url": "https://x.dev/a.git", "full_name": "acme/a", "app_name": "shop", "drift": None}
PLAN = {"id": "p1", "repo_id": "gr1", "environment": "production", "status": "held"}


def test_apps_list_and_find():
    client, opener = make_client(page(APP), page(APP), page(APP))
    apps, _ = client.apps.list()
    check(opener.requests[0], "GET", "/apps")
    assert apps[0].app_name == "shop"
    assert client.apps.find("acme/a").repo_id == "gr1"
    assert client.apps.find("nope") is None


def test_apps_plans_and_plan():
    client, opener = make_client(page(PLAN), PLAN)
    plans, _ = client.apps.plans("gr1", environment="staging", limit=5)
    check(opener.requests[0], "GET", "/apps/gr1/plans?environment=staging&limit=5")
    assert plans[0].id == "p1"
    assert client.apps.plan("p1").status == "held"
    check(opener.requests[1], "GET", "/apps/plans/p1")


def test_apps_confirm():
    client, opener = make_client({"status": "applied", "confirmed": ["resource.delete:files"]})
    assert client.apps.confirm("p1", ["resource.delete:files"]).status == "applied"
    check(opener.requests[0], "POST", "/apps/plans/p1/confirm", {"action_ids": ["resource.delete:files"]})


def test_apps_toggles_send_false():
    client, opener = make_client(
        {"repo_id": "gr1", "require_approval": False}, {"repo_id": "gr1", "enforce_drift": False}
    )
    assert client.apps.set_require_approval("gr1", False).require_approval is False
    check(opener.requests[0], "PUT", "/apps/gr1/require-approval", {"require_approval": False})
    assert client.apps.set_enforce_drift("gr1", False).enforce_drift is False
    check(opener.requests[1], "PUT", "/apps/gr1/enforce-drift", {"enforce_drift": False})


def test_apps_deploy():
    result = {"plan_id": None, "status": "skipped", "environment": None, "stack": None, "reason": "no swarmy.yaml", "plan": None}
    client, opener = make_client(result, result)
    assert client.apps.deploy("gr1").reason == "no swarmy.yaml"
    check(opener.requests[0], "POST", "/apps/gr1/deploy", {})
    client.apps.deploy("gr1", branch="main")
    check(opener.requests[1], "POST", "/apps/gr1/deploy", {"branch": "main"})


def test_apps_drift():
    client, opener = make_client(page({"environment": "production", "stack": "shop", "changes": 2}))
    drift, _ = client.apps.drift("gr1")
    check(opener.requests[0], "GET", "/apps/gr1/drift")
    assert drift[0].changes == 2


def test_apps_purge_data():
    client, opener = make_client({"stack": "shop", "resource": "db", "volumes": ["v1"], "nodes": 2})
    assert client.apps.purge_data("gr1", "production", "db", "shop/db").nodes == 2
    check(opener.requests[0], "POST", "/apps/gr1/environments/production/purge", {"resource": "db", "confirm": "shop/db"})


def test_apps_promote():
    client, opener = make_client({"plan_id": "p2", "status": "planned", "plan": None, "images": {"web": "sha256:x"}})
    assert client.apps.promote("gr1", from_="staging").plan_id == "p2"
    check(opener.requests[0], "POST", "/apps/gr1/promote", {"from": "staging"})


def test_apps_preview():
    client, opener = make_client(FakeResponse({"action": "deployed", "stack": "shop-pr-1", "url": "https://p", "reason": None}, status=202))
    assert client.apps.preview("gr1", "feature/x").stack == "shop-pr-1"
    check(opener.requests[0], "POST", "/apps/gr1/previews", {"branch": "feature/x"})


# --- deployments ---------------------------------------------------------------------------------


def test_deployments_get():
    client, opener = make_client({"deployment_id": "d1", "kind": "service", "phase": "converged"})
    assert client.deployments.get("d1").phase == "converged"
    check(opener.requests[0], "GET", "/deployments/d1")


def test_deployments_events():
    client, opener = make_client({"deploy_id": "dp1", "stack": "shop", "started_at": 1, "done": True, "data": []})
    assert client.deployments.events("dp1").done is True
    check(opener.requests[0], "GET", "/deploys/dp1/events")


def test_api_error_still_maps_for_raw_and_stream():
    import urllib.error

    problem = {"type": "about:blank", "title": "Forbidden", "status": 403, "detail": "no", "swarmy_code": "POLICY_DENIED"}

    class ErrOpener(MockOpener):
        def open(self, req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", None, io.BytesIO(json.dumps(problem).encode()))

    client = swarmy.SwarmyClient("https://swarm.example.com", "swk_test", opener=ErrOpener([]))
    with pytest.raises(swarmy.SwarmyApiError) as ei:
        client.audit.export()
    assert ei.value.code == "POLICY_DENIED"
    with pytest.raises(swarmy.SwarmyApiError):
        list(client.services.follow_logs("s1"))
