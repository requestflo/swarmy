"""Resource groups for the swarmy client (hand-written, stable)."""

from __future__ import annotations

import urllib.parse
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

from ._http import HttpTransport
from .models import (
    DeploymentRef,
    IngressDomain,
    Node,
    Removed,
    Service,
    Stack,
)


def _quote(value: str) -> str:
    return urllib.parse.quote(str(value), safe="")


def _list_query(cursor: Optional[str], limit: Optional[int]) -> Dict[str, Any]:
    return {"cursor": cursor, "limit": limit}


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

    def restart(self, service_id: str) -> DeploymentRef:
        return DeploymentRef.from_dict(
            self._http.request("POST", "/services/{}/restart".format(_quote(service_id)))
        )

    def remove(self, service_id: str) -> Removed:
        return Removed.from_dict(self._http.request("DELETE", "/services/{}".format(_quote(service_id))))

    def iterate(self, limit: Optional[int] = None) -> Iterator[Service]:
        return _paginate(lambda c: self.list(cursor=c, limit=limit))


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

    def remove(self, stack_id: str) -> Removed:
        return Removed.from_dict(self._http.request("DELETE", "/stacks/{}".format(_quote(stack_id))))

    def iterate(self, limit: Optional[int] = None) -> Iterator[Stack]:
        return _paginate(lambda c: self.list(cursor=c, limit=limit))


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
    ) -> IngressDomain:
        payload: Dict[str, Any] = {"host": host, "service_id": service_id, "target_port": target_port}
        if tls is not None:
            payload["tls"] = tls
        if path_prefix is not None:
            payload["path_prefix"] = path_prefix
        return IngressDomain.from_dict(self._http.request("POST", "/ingress/domains", body=payload))

    def remove_domain(self, domain_id: str) -> Removed:
        return Removed.from_dict(
            self._http.request("DELETE", "/ingress/domains/{}".format(_quote(domain_id)))
        )

    def iterate_domains(self, limit: Optional[int] = None) -> Iterator[IngressDomain]:
        return _paginate(lambda c: self.list_domains(cursor=c, limit=limit))
