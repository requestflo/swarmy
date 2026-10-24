"""Resource groups for the swarmy client (hand-written, stable)."""

from __future__ import annotations

import json
import urllib.parse
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

from ._http import HttpTransport
from .models import (
    DeploymentRef,
    ErrorProject,
    IngressDomain,
    IngressDomainDetail,
    IngressSettings,
    JoinToken,
    JoinTokenIssued,
    LogLine,
    Node,
    NodeAvailability,
    NodeLabels,
    PatchServiceEnvResult,
    Removed,
    Revoked,
    Service,
    ServiceEnv,
    Stack,
    StackConnection,
    StackEndpoints,
    StackErrorsStatus,
    StackRemoved,
    StackTelemetry,
)


class _Unset:
    """Marks a keyword argument as not given, where ``None`` means send ``null``."""

    def __repr__(self) -> str:
        return "UNSET"


_UNSET: Any = _Unset()


def _quote(value: str) -> str:
    return urllib.parse.quote(str(value), safe="")


def _list_query(cursor: Optional[str], limit: Optional[int]) -> Dict[str, Any]:
    return {"cursor": cursor, "limit": limit}


def _compact(fields_: Dict[str, Any]) -> Dict[str, Any]:
    """The body with every ``None`` (not given) argument left out."""
    return {k: v for k, v in fields_.items() if v is not None}


def _sse_data(resp: Any) -> Iterator[str]:
    """The ``data:`` payloads of a Server-Sent Events response, one per event."""
    data: List[str] = []
    while True:
        raw = resp.readline()
        if not raw:
            break
        line = raw.decode("utf-8").rstrip("\r\n")
        if line == "":
            if data:
                yield "\n".join(data)
            data = []
        elif line.startswith("data:"):
            value = line[5:]
            data.append(value[1:] if value.startswith(" ") else value)
    if data:
        yield "\n".join(data)


def _paginate(
    fetch_page: Callable[[Optional[str]], Tuple[List[Any], Optional[str]]],
) -> Iterator[Any]:
    cursor: Optional[str] = None
    while True:
        items, next_cursor = fetch_page(cursor)
        for item in items:
            yield item
        if not next_cursor:
            return
        cursor = next_cursor


class ServicesResource:
    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def list(self, cursor: Optional[str] = None, limit: Optional[int] = None) -> Tuple[List[Service], Optional[str]]:
        body = self._http.request("GET", "/services", query=_list_query(cursor, limit))
        return [Service.from_dict(x) for x in body["data"]], body.get("next_cursor")

    def get(self, service_id: str) -> Service:
        return Service.from_dict(self._http.request("GET", "/services/{}".format(_quote(service_id))))

    def create(
        self,
        name: str,
        image: str,
        replicas: Optional[int] = None,
        command: Optional[List[str]] = None,
        env: Optional[List[Dict[str, str]]] = None,
        node_id: Optional[str] = None,
    ) -> DeploymentRef:
        payload: Dict[str, Any] = {"name": name, "image": image}
        if replicas is not None:
            payload["replicas"] = replicas
        if command is not None:
            payload["command"] = command
        if env is not None:
            payload["env"] = env
        if node_id is not None:
            payload["node_id"] = node_id
        return DeploymentRef.from_dict(self._http.request("POST", "/services", body=payload))

    def scale(self, service_id: str, replicas: int) -> DeploymentRef:
        return DeploymentRef.from_dict(
            self._http.request("POST", "/services/{}/scale".format(_quote(service_id)), body={"replicas": replicas})
        )

    def update(
        self,
        service_id: str,
        image: Optional[str] = None,
        replicas: Optional[int] = None,
        command: Optional[List[str]] = None,
        env: Optional[List[Dict[str, Any]]] = None,
        remove_secret_keys: Optional[List[str]] = None,
        resources: Optional[Dict[str, Any]] = None,
        restart_policy: Optional[Dict[str, Any]] = None,
        update_order: Optional[str] = None,
        set_labels: Optional[Dict[str, str]] = None,
        remove_labels: Optional[List[str]] = None,
    ) -> DeploymentRef:
        """Change a running service: only the arguments given change, the rest keep
        their live values. Async (202). ``env`` is the plain variables as a whole
        (``{"key", "value", "secret"?, "delivery"?}`` items). It runs the same
        admission checks as a deploy, so a guardrail can refuse it
        (``SwarmyApiError`` 412, code ``POLICY_DENIED``)."""
        fields = {
            "image": image,
            "replicas": replicas,
            "command": command,
            "env": env,
            "remove_secret_keys": remove_secret_keys,
            "resources": resources,
            "restart_policy": restart_policy,
            "update_order": update_order,
            "set_labels": set_labels,
            "remove_labels": remove_labels,
        }
        payload = {k: v for k, v in fields.items() if v is not None}
        return DeploymentRef.from_dict(
            self._http.request("PATCH", "/services/{}".format(_quote(service_id)), body=payload)
        )

    def restart(self, service_id: str) -> DeploymentRef:
        return DeploymentRef.from_dict(
            self._http.request("POST", "/services/{}/restart".format(_quote(service_id)))
        )

    def remove(self, service_id: str) -> Removed:
        return Removed.from_dict(self._http.request("DELETE", "/services/{}".format(_quote(service_id))))

    def iterate(self, limit: Optional[int] = None) -> Iterator[Service]:
        return _paginate(lambda c: self.list(cursor=c, limit=limit))

    def env(self, service_id: str, reveal_secrets: bool = False) -> ServiceEnv:
        """The service's environment. Secret values are ``None`` unless
        ``reveal_secrets`` is set AND the key holds the ``secrets.read`` scope AND
        policy permits it (each reveal is audited)."""
        query = {"reveal_secrets": "true"} if reveal_secrets else None
        return ServiceEnv.from_dict(
            self._http.request("GET", "/services/{}/env".format(_quote(service_id)), query=query)
        )

    def patch_env(
        self,
        service_id: str,
        set: Optional[Dict[str, str]] = None,
        secrets: Optional[Dict[str, str]] = None,
        unset: Optional[List[str]] = None,
    ) -> PatchServiceEnvResult:
        """Merge-patch the environment: ``set`` plain vars, ``secrets`` secret vars,
        ``unset`` keys to drop; keys not named are kept. Async rollout (202)."""
        payload = _compact({"set": set, "secrets": secrets, "unset": unset})
        return PatchServiceEnvResult.from_dict(
            self._http.request("PATCH", "/services/{}/env".format(_quote(service_id)), body=payload)
        )

    def logs(
        self, service_id: str, tail: Optional[int] = None, since: Optional[int] = None
    ) -> Tuple[List[LogLine], Optional[str]]:
        """The last ``tail`` log lines of every task (oldest first); ``since`` is a unix time."""
        body = self._http.request(
            "GET", "/services/{}/logs".format(_quote(service_id)), query={"tail": tail, "since": since}
        )
        return [LogLine.from_dict(x) for x in body["data"]], body.get("next_cursor")

    def follow_logs(
        self,
        service_id: str,
        tail: Optional[int] = None,
        since: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> Iterator[LogLine]:
        """Follow the logs (Server-Sent Events): yields each line as it arrives
        until the server ends the stream or the iterator is closed. ``timeout``
        bounds each read (``None`` waits on a quiet service); a malformed event
        is skipped."""
        resp = self._http.stream(
            "GET",
            "/services/{}/logs/stream".format(_quote(service_id)),
            query={"tail": tail, "since": since},
            timeout=timeout,
        )
        try:
            for data in _sse_data(resp):
                try:
                    yield LogLine.from_dict(json.loads(data))
                except (ValueError, AttributeError):
                    continue
        finally:
            close = getattr(resp, "close", None)
            if close is not None:
                close()


class StacksResource:
    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def list(self, cursor: Optional[str] = None, limit: Optional[int] = None) -> Tuple[List[Stack], Optional[str]]:
        body = self._http.request("GET", "/stacks", query=_list_query(cursor, limit))
        return [Stack.from_dict(x) for x in body["data"]], body.get("next_cursor")

    def get(self, stack_id: str) -> Stack:
        return Stack.from_dict(self._http.request("GET", "/stacks/{}".format(_quote(stack_id))))

    def deploy(self, name: str, compose_source: str) -> DeploymentRef:
        return DeploymentRef.from_dict(
            self._http.request("POST", "/stacks", body={"name": name, "compose_source": compose_source})
        )

    def remove(self, stack_id: str, delete_data: bool = False) -> StackRemoved:
        """Remove a stack. Its data (named volumes + its blueprint's generated
        secrets) is kept unless ``delete_data`` — a same-name redeploy picks it back up."""
        query = {"delete_data": "true"} if delete_data else None
        return StackRemoved.from_dict(
            self._http.request("DELETE", "/stacks/{}".format(_quote(stack_id)), query=query)
        )

    def endpoints(self, stack_id: str) -> StackEndpoints:
        """How to reach the app's services and managed resources from inside the
        cluster: the DNS names swarm answers and each resource's host:port."""
        return StackEndpoints.from_dict(
            self._http.request("GET", "/stacks/{}/endpoints".format(_quote(stack_id)))
        )

    def connect(self, stack_id: str, peer: str) -> StackConnection:
        """Connect two apps over one private network (both roll once to join it).
        ``stack_id`` and ``peer`` are a stack id or name. Idempotent."""
        return StackConnection.from_dict(
            self._http.request("POST", "/stacks/{}/connections".format(_quote(stack_id)), body={"peer": peer})
        )

    def disconnect(self, stack_id: str, peer: str) -> StackConnection:
        """Disconnect two apps: both leave the pair network."""
        return StackConnection.from_dict(
            self._http.request(
                "DELETE", "/stacks/{}/connections/{}".format(_quote(stack_id), _quote(peer))
            )
        )

    def iterate(self, limit: Optional[int] = None) -> Iterator[Stack]:
        return _paginate(lambda c: self.list(cursor=c, limit=limit))

    def telemetry(self, stack_id: str) -> StackTelemetry:
        """Whether OpenTelemetry is on for the stack."""
        return StackTelemetry.from_dict(
            self._http.request("GET", "/stacks/{}/telemetry".format(_quote(stack_id)))
        )

    def set_telemetry(self, stack_id: str, enabled: bool) -> StackTelemetry:
        """Turn OpenTelemetry on or off for the stack (admin)."""
        return StackTelemetry.from_dict(
            self._http.request("PUT", "/stacks/{}/telemetry".format(_quote(stack_id)), body={"enabled": enabled})
        )

    def errors(self, stack_id: str) -> StackErrorsStatus:
        """Error tracking for the stack: opt-in state and the Sentry-compatible DSN."""
        return StackErrorsStatus.from_dict(
            self._http.request("GET", "/stacks/{}/errors".format(_quote(stack_id)))
        )

    def rotate_errors_key(self, stack_id: str) -> ErrorProject:
        """A new DSN key; the old one stops working at once (admin)."""
        return ErrorProject.from_dict(
            self._http.request("POST", "/stacks/{}/errors/rotate-key".format(_quote(stack_id)))
        )


class NodesResource:
    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def list(self, cursor: Optional[str] = None, limit: Optional[int] = None) -> Tuple[List[Node], Optional[str]]:
        body = self._http.request("GET", "/nodes", query=_list_query(cursor, limit))
        return [Node.from_dict(x) for x in body["data"]], body.get("next_cursor")

    def get(self, node_id: str) -> Node:
        return Node.from_dict(self._http.request("GET", "/nodes/{}".format(_quote(node_id))))

    def iterate(self, limit: Optional[int] = None) -> Iterator[Node]:
        return _paginate(lambda c: self.list(cursor=c, limit=limit))

    def remove(self, node_id: str) -> Removed:
        """Remove a node from the swarm."""
        return Removed.from_dict(self._http.request("DELETE", "/nodes/{}".format(_quote(node_id))))

    def drain(self, node_id: str) -> NodeAvailability:
        """Drain (cordon) a node: nothing new is scheduled on it and its tasks move off."""
        return NodeAvailability.from_dict(
            self._http.request("POST", "/nodes/{}/drain".format(_quote(node_id)))
        )

    def uncordon(self, node_id: str) -> NodeAvailability:
        """Uncordon a node: its availability goes back to ``active``."""
        return NodeAvailability.from_dict(
            self._http.request("POST", "/nodes/{}/uncordon".format(_quote(node_id)))
        )

    def set_labels(self, node_id: str, labels: Dict[str, str]) -> NodeLabels:
        """Replace a node's labels with ``labels`` (labels not named are removed)."""
        return NodeLabels.from_dict(
            self._http.request("PUT", "/nodes/{}/labels".format(_quote(node_id)), body={"labels": labels})
        )


class IngressResource:
    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def list_domains(
        self, cursor: Optional[str] = None, limit: Optional[int] = None
    ) -> Tuple[List[IngressDomain], Optional[str]]:
        body = self._http.request("GET", "/ingress/domains", query=_list_query(cursor, limit))
        return [IngressDomain.from_dict(x) for x in body["data"]], body.get("next_cursor")

    def add_domain(
        self,
        host: str,
        service_id: str,
        target_port: int,
        tls: Optional[str] = None,
        path_prefix: Optional[str] = None,
        www: Optional[str] = None,
    ) -> IngressDomain:
        payload: Dict[str, Any] = {"host": host, "service_id": service_id, "target_port": target_port}
        if tls is not None:
            payload["tls"] = tls
        if path_prefix is not None:
            payload["path_prefix"] = path_prefix
        if www is not None:
            payload["www"] = www
        return IngressDomain.from_dict(self._http.request("POST", "/ingress/domains", body=payload))

    def remove_domain(self, domain_id: str) -> Removed:
        return Removed.from_dict(
            self._http.request("DELETE", "/ingress/domains/{}".format(_quote(domain_id)))
        )

    def iterate_domains(self, limit: Optional[int] = None) -> Iterator[IngressDomain]:
        return _paginate(lambda c: self.list_domains(cursor=c, limit=limit))

    def update_domain(self, domain_id: str, www: Optional[str]) -> IngressDomain:
        """Set the apex/www pairing (``redirect-www-to-apex``, ``redirect-apex-to-www``,
        ``serve-both``); ``None`` clears it."""
        return IngressDomain.from_dict(
            self._http.request("PATCH", "/ingress/domains/{}".format(_quote(domain_id)), body={"www": www})
        )

    def domain_status(self, domain_id: str) -> IngressDomainDetail:
        """The domain's DNS + certificate status and how to point DNS at it."""
        return IngressDomainDetail.from_dict(
            self._http.request("GET", "/ingress/domains/{}/status".format(_quote(domain_id)))
        )

    def verify_domain(self, domain_id: str) -> IngressDomainDetail:
        """Re-check the domain's DNS and certificate now."""
        return IngressDomainDetail.from_dict(
            self._http.request("POST", "/ingress/domains/{}/verify".format(_quote(domain_id)))
        )

    def settings(self) -> IngressSettings:
        """The org's edge settings: driver, topology, image, target nodes, TLS,
        tunnel and DNS provider (secrets read back as set / not set)."""
        return IngressSettings.from_dict(self._http.request("GET", "/ingress/settings"))

    def update_settings(self, **fields: Any) -> IngressSettings:
        """Change the edge settings in one write (admins and owners); returns them
        as they now are. Pass the request fields as keyword arguments (``driver``,
        ``enabled``, ``topology``, ``controller_image``, ``target_nodes``, ``tls``,
        ``tunnel``, ``dns_provider``): ONLY the ones given are sent, so a setting
        left out keeps its value, and ``None`` sends ``null``, which clears a
        nullable one (``tunnel=None`` disconnects the tunnel).

        >>> client.ingress.update_settings(enabled=False)
        """
        return IngressSettings.from_dict(self._http.request("PUT", "/ingress/settings", body=dict(fields)))


class JoinTokensResource:
    """Join tokens: what a new server's installer presents to enroll."""

    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def list(self) -> Tuple[List[JoinToken], Optional[str]]:
        """The org's join tokens, newest first (never the token itself)."""
        body = self._http.request("GET", "/join-tokens")
        return [JoinToken.from_dict(x) for x in body["data"]], body.get("next_cursor")

    def create(
        self,
        label: Optional[str] = None,
        ttl_seconds: Optional[int] = None,
        max_uses: Optional[int] = None,
        profile: Optional[str] = None,
    ) -> JoinTokenIssued:
        """Mint a join token (admins and owners). ``token``, and ``mesh`` when the
        org runs a mesh, are returned ONCE — store them."""
        fields = {"label": label, "ttl_seconds": ttl_seconds, "max_uses": max_uses, "profile": profile}
        payload = {k: v for k, v in fields.items() if v is not None}
        return JoinTokenIssued.from_dict(self._http.request("POST", "/join-tokens", body=payload))

    def revoke(self, token_id: str) -> Revoked:
        """Revoke a join token: it enrolls nothing from now on."""
        return Revoked.from_dict(self._http.request("DELETE", "/join-tokens/{}".format(_quote(token_id))))
