"""Request-building tests using a mocked urllib opener."""

import io
import json
import urllib.error

import pytest

import swarmy


class FakeResponse:
    def __init__(self, body, status=200):
        self._body = body.encode("utf-8") if isinstance(body, str) else body
        self.status = status

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class MockOpener:
    """Captures requests and replays a queue of responses."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.requests = []

    def open(self, req, timeout=None):
        self.requests.append(req)
        resp = self._responses.pop(0)
        if isinstance(resp, Exception):
            raise resp
        return resp


def make_client(responses):
    opener = MockOpener(responses)
    client = swarmy.SwarmyClient("https://swarm.example.com/", "swk_test", opener=opener)
    return client, opener


def test_repr_and_construction():
    client, _ = make_client([])
    assert "swarm.example.com/api/v1" in repr(client)


def test_list_builds_url_and_auth_header():
    client, opener = make_client([FakeResponse(json.dumps({"data": [], "next_cursor": None}))])
    services, next_cursor = client.services.list()
    assert services == []
    assert next_cursor is None
    req = opener.requests[0]
    assert req.full_url == "https://swarm.example.com/api/v1/services"
    assert req.get_method() == "GET"
    # urllib capitalises header keys.
    assert req.headers["Authorization"] == "Bearer swk_test"
    assert "application/problem+json" in req.headers["Accept"]


def test_no_double_api_prefix():
    client = swarmy.SwarmyClient(
        "https://swarm.example.com/api/v1", "swk_x", opener=MockOpener([FakeResponse('{"data":[],"next_cursor":null}')])
    )
    client.nodes.list()


def test_post_serialises_body_and_encodes_id():
    client, opener = make_client([FakeResponse(json.dumps({"id": "s1", "deployment_id": "d1"}), status=202)])
    ref = client.services.scale("svc/with space", 3)
    req = opener.requests[0]
    assert req.full_url == "https://swarm.example.com/api/v1/services/svc%2Fwith%20space/scale"
    assert req.get_method() == "POST"
    assert json.loads(req.data.decode("utf-8")) == {"replicas": 3}
    assert req.headers["Content-type"] == "application/json"
    assert ref.deployment_id == "d1"


def test_create_omits_unset_optional_fields():
    client, opener = make_client([FakeResponse(json.dumps({"id": "s1", "deployment_id": "d1"}), status=202)])
    client.services.create(name="web", image="nginx:latest")
    body = json.loads(opener.requests[0].data.decode("utf-8"))
    assert body == {"name": "web", "image": "nginx:latest"}


def test_list_query_params():
    client, opener = make_client([FakeResponse('{"data":[],"next_cursor":null}')])
    client.stacks.list(cursor="abc", limit=50)
    url = opener.requests[0].full_url
    assert "cursor=abc" in url and "limit=50" in url


def test_problem_json_maps_to_error():
    problem = {
        "type": "https://swarmy.dev/errors/not-found",
        "title": "Not Found",
        "status": 404,
        "detail": "no such service",
        "swarmy_code": "service_not_found",
    }
    err = urllib.error.HTTPError(
        url="https://x/api/v1/services/missing",
        code=404,
        msg="Not Found",
        hdrs=None,
        fp=io.BytesIO(json.dumps(problem).encode("utf-8")),
    )
    client, _ = make_client([err])
    with pytest.raises(swarmy.SwarmyApiError) as ei:
        client.services.get("missing")
    assert ei.value.status == 404
    assert ei.value.code == "service_not_found"
    assert ei.value.problem.detail == "no such service"
    assert str(ei.value) == "no such service"


def test_iterate_follows_next_cursor():
    page1 = json.dumps(
        {
            "data": [
                {"id": "a", "name": "a", "image": "i", "status": "ok", "replicas": {"desired": 1, "running": 1},
                 "ingress_enabled": False, "node_id": None, "stack_id": None, "updated_at": "t"},
                {"id": "b", "name": "b", "image": "i", "status": "ok", "replicas": {"desired": 1, "running": 1},
                 "ingress_enabled": False, "node_id": None, "stack_id": None, "updated_at": "t"},
            ],
            "next_cursor": "p2",
        }
    )
    page2 = json.dumps(
        {
            "data": [
                {"id": "c", "name": "c", "image": "i", "status": "ok", "replicas": {"desired": 1, "running": 1},
                 "ingress_enabled": False, "node_id": None, "stack_id": None, "updated_at": "t"},
            ],
            "next_cursor": None,
        }
    )
    client, _ = make_client([FakeResponse(page1), FakeResponse(page2)])
    ids = [s.id for s in client.services.iterate()]
    assert ids == ["a", "b", "c"]


def test_missing_endpoint_raises():
    with pytest.raises(ValueError):
        swarmy.SwarmyClient("", "swk_x")
    with pytest.raises(ValueError):
        swarmy.SwarmyClient("http://x", "")


def test_keyword_field_is_escaped_but_reads_the_wire_name():
    # `from` is a Python keyword: the generated attribute is `from_`, the wire key stays "from".
    from swarmy.models import AppPreviewData, PromoteAppBody

    assert AppPreviewData.from_dict({"from": "production", "scrub": None}).from_ == "production"
    assert PromoteAppBody.from_dict({"from": "staging"}).from_ == "staging"


def test_stack_remove_keeps_data_unless_delete_data():
    removed = {"id": "stk_1", "removed": True, "delete_data": False, "volumes_deleted": [], "volumes_kept": ["shop_data"]}
    client, opener = make_client([FakeResponse(json.dumps(removed)), FakeResponse(json.dumps({**removed, "delete_data": True}))])
    kept = client.stacks.remove("stk_1")
    assert opener.requests[0].get_method() == "DELETE"
    assert opener.requests[0].full_url == "https://swarm.example.com/api/v1/stacks/stk_1"
    assert kept.volumes_kept == ["shop_data"]
    gone = client.stacks.remove("stk_1", delete_data=True)
    assert opener.requests[1].full_url == "https://swarm.example.com/api/v1/stacks/stk_1?delete_data=true"
    assert gone.delete_data is True


def test_service_update_patches_only_given_fields():
    client, opener = make_client([FakeResponse(json.dumps({"id": "svc-1", "deployment_id": "svc-1"}), status=202)])
    ref = client.services.update(
        "svc-1",
        image="nginx:1.28",
        replicas=0,
        env=[{"key": "LOG_LEVEL", "value": "debug"}],
        resources={"limits": {"cpus": 0.5}},
    )
    req = opener.requests[0]
    assert req.get_method() == "PATCH"
    assert req.full_url == "https://swarm.example.com/api/v1/services/svc-1"
    assert json.loads(req.data.decode("utf-8")) == {
        "image": "nginx:1.28",
        "replicas": 0,
        "env": [{"key": "LOG_LEVEL", "value": "debug"}],
        "resources": {"limits": {"cpus": 0.5}},
    }
    assert ref.deployment_id == "svc-1"


def test_stack_connections():
    conn = {"stack": "shop", "peer": "billing", "network": "swarmy-link-ab12", "services": ["shop_web"]}
    endpoints = {"stack": "shop", "connected_apps": ["billing"], "services": [], "resources": []}
    client, opener = make_client(
        [FakeResponse(json.dumps(conn)), FakeResponse(json.dumps({**conn, "services": []})), FakeResponse(json.dumps(endpoints))]
    )
    out = client.stacks.connect("shop", "billing")
    assert opener.requests[0].get_method() == "POST"
    assert opener.requests[0].full_url == "https://swarm.example.com/api/v1/stacks/shop/connections"
    assert json.loads(opener.requests[0].data.decode("utf-8")) == {"peer": "billing"}
    assert out.network == "swarmy-link-ab12"
    client.stacks.disconnect("shop", "bill ing")
    assert opener.requests[1].get_method() == "DELETE"
    assert opener.requests[1].full_url == "https://swarm.example.com/api/v1/stacks/shop/connections/bill%20ing"
    ep = client.stacks.endpoints("shop")
    assert opener.requests[2].full_url == "https://swarm.example.com/api/v1/stacks/shop/endpoints"
    assert ep.connected_apps == ["billing"]


def test_join_tokens():
    issued = {
        "id": "jt1", "token": "swt_ab12cd34_x", "label": "ci", "profile": None, "expires_at": "2026-10-01T01:00:00.000Z",
        "max_uses": 1, "mesh": None, "install": {"url": "https://swarm.example.com", "loopback": False, "warning": None},
    }
    listed = {"data": [{"id": "jt1", "label": "ci", "profile": None, "token_prefix": "ab12cd34",
                        "created_at": "2026-10-01T00:00:00.000Z", "expires_at": None, "max_uses": 1, "used_count": 0,
                        "revoked_at": None, "status": "active"}], "next_cursor": None}
    client, opener = make_client(
        [FakeResponse(json.dumps(issued), status=201), FakeResponse(json.dumps(listed)),
         FakeResponse(json.dumps({"id": "jt1", "revoked": True}))]
    )
    tok = client.join_tokens.create(label="ci", ttl_seconds=3600)
    assert opener.requests[0].get_method() == "POST"
    assert opener.requests[0].full_url == "https://swarm.example.com/api/v1/join-tokens"
    assert json.loads(opener.requests[0].data.decode("utf-8")) == {"label": "ci", "ttl_seconds": 3600}
    assert tok.token == "swt_ab12cd34_x" and tok.mesh is None
    tokens, next_cursor = client.join_tokens.list()
    assert [t.token_prefix for t in tokens] == ["ab12cd34"] and next_cursor is None
    assert not hasattr(tokens[0], "token")
    revoked = client.join_tokens.revoke("jt1")
    assert opener.requests[2].get_method() == "DELETE"
    assert opener.requests[2].full_url == "https://swarm.example.com/api/v1/join-tokens/jt1"
    assert revoked.revoked is True
