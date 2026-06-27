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
