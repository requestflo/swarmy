"""GENERATED FILE - do not edit by hand.

Regenerate with: ``bun run scripts/gen-sdks.ts`` from the repo root.
Source of truth: packages/api-rest/openapi.json
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional


@dataclass
class ServiceReplicas:
    desired: float
    running: float

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ServiceReplicas":
        return cls(
            desired=d.get("desired"),
            running=d.get("running"),
        )


@dataclass
class EnvVar:
    key: str
    value: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "EnvVar":
        return cls(
            key=d.get("key"),
            value=d.get("value"),
        )


@dataclass
class Node:
    id: str
    name: str
    hostname: str
    role: str
    status: str
    engine_version: Optional[str]
    os: Optional[str]
    arch: Optional[str]
    last_seen_at: Optional[str]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Node":
        return cls(
            id=d.get("id"),
            name=d.get("name"),
            hostname=d.get("hostname"),
            role=d.get("role"),
            status=d.get("status"),
            engine_version=d.get("engine_version"),
            os=d.get("os"),
            arch=d.get("arch"),
            last_seen_at=d.get("last_seen_at"),
        )


@dataclass
class Problem:
    type: str
    title: str
    status: float
    detail: Optional[str] = None
    instance: Optional[str] = None
    swarmy_code: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Problem":
        return cls(
            type=d.get("type"),
            title=d.get("title"),
            status=d.get("status"),
            detail=d.get("detail"),
            instance=d.get("instance"),
            swarmy_code=d.get("swarmy_code"),
        )


@dataclass
class NodeAvailability:
    id: str
    availability: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "NodeAvailability":
        return cls(
            id=d.get("id"),
            availability=d.get("availability"),
        )


@dataclass
class NodeLabels:
    id: str
    labels: Dict[str, Any]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "NodeLabels":
        return cls(
            id=d.get("id"),
            labels=d.get("labels"),
        )


@dataclass
class Removed:
    id: str
    removed: bool

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Removed":
        return cls(
            id=d.get("id"),
            removed=d.get("removed"),
        )


@dataclass
class Service:
    id: str
    name: str
    image: str
    status: str
    replicas: ServiceReplicas
    ingress_enabled: bool
    node_id: Optional[str]
    stack_id: Optional[str]
    updated_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Service":
        return cls(
            id=d.get("id"),
            name=d.get("name"),
            image=d.get("image"),
            status=d.get("status"),
            replicas=ServiceReplicas.from_dict(d.get("replicas") or {}),
            ingress_enabled=d.get("ingress_enabled"),
            node_id=d.get("node_id"),
            stack_id=d.get("stack_id"),
            updated_at=d.get("updated_at"),
        )


@dataclass
class DeploymentRef:
    id: str
    deployment_id: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "DeploymentRef":
        return cls(
            id=d.get("id"),
            deployment_id=d.get("deployment_id"),
        )


@dataclass
class Stack:
    id: str
    name: str
    service_count: float
    status: str
    updated_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Stack":
        return cls(
            id=d.get("id"),
            name=d.get("name"),
            service_count=d.get("service_count"),
            status=d.get("status"),
            updated_at=d.get("updated_at"),
        )


@dataclass
class IngressDomain:
    id: str
    host: str
    service_id: str
    service_name: str
    target_port: float
    tls: str
    path_prefix: Optional[str]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "IngressDomain":
        return cls(
            id=d.get("id"),
            host=d.get("host"),
            service_id=d.get("service_id"),
            service_name=d.get("service_name"),
            target_port=d.get("target_port"),
            tls=d.get("tls"),
            path_prefix=d.get("path_prefix"),
        )


@dataclass
class ApiKey:
    id: str
    name: str
    prefix: str
    scopes: List[str]
    last_used_at: Optional[str]
    created_at: str
    created_by_id: Optional[str]
    revoked_at: Optional[str]
    status: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ApiKey":
        return cls(
            id=d.get("id"),
            name=d.get("name"),
            prefix=d.get("prefix"),
            scopes=d.get("scopes"),
            last_used_at=d.get("last_used_at"),
            created_at=d.get("created_at"),
            created_by_id=d.get("created_by_id"),
            revoked_at=d.get("revoked_at"),
            status=d.get("status"),
        )


@dataclass
class Revoked:
    id: str
    revoked: bool

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Revoked":
        return cls(
            id=d.get("id"),
            revoked=d.get("revoked"),
        )


@dataclass
class DnsRecord:
    id: str
    host: str
    region: str
    target_ingress: str
    healthy: bool

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "DnsRecord":
        return cls(
            id=d.get("id"),
            host=d.get("host"),
            region=d.get("region"),
            target_ingress=d.get("target_ingress"),
            healthy=d.get("healthy"),
        )


@dataclass
class BackupTarget:
    id: str
    name: str
    kind: str
    endpoint: Optional[str]
    bucket: str
    prefix: Optional[str]
    region: Optional[str]
    has_credentials: bool
    enabled: bool
    created_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "BackupTarget":
        return cls(
            id=d.get("id"),
            name=d.get("name"),
            kind=d.get("kind"),
            endpoint=d.get("endpoint"),
            bucket=d.get("bucket"),
            prefix=d.get("prefix"),
            region=d.get("region"),
            has_credentials=d.get("has_credentials"),
            enabled=d.get("enabled"),
            created_at=d.get("created_at"),
        )


@dataclass
class Snapshot:
    id: str
    volume: str
    target_id: str
    target_name: str
    status: str
    restic_id: Optional[str]
    size_bytes: Optional[str]
    error: Optional[str]
    started_at: str
    finished_at: Optional[str]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Snapshot":
        return cls(
            id=d.get("id"),
            volume=d.get("volume"),
            target_id=d.get("target_id"),
            target_name=d.get("target_name"),
            status=d.get("status"),
            restic_id=d.get("restic_id"),
            size_bytes=d.get("size_bytes"),
            error=d.get("error"),
            started_at=d.get("started_at"),
            finished_at=d.get("finished_at"),
        )


@dataclass
class BackupRun:
    snapshot_id: str
    restic_id: str
    size_bytes: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "BackupRun":
        return cls(
            snapshot_id=d.get("snapshot_id"),
            restic_id=d.get("restic_id"),
            size_bytes=d.get("size_bytes"),
        )


@dataclass
class RestoreResult:
    target_volume: str
    bytes_restored: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "RestoreResult":
        return cls(
            target_volume=d.get("target_volume"),
            bytes_restored=d.get("bytes_restored"),
        )


@dataclass
class ClusterVolume:
    id: str
    name: str
    csi_driver: str
    access_mode: str
    capacity_bytes: Optional[str]
    status: str
    service_id: Optional[str]
    created_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ClusterVolume":
        return cls(
            id=d.get("id"),
            name=d.get("name"),
            csi_driver=d.get("csi_driver"),
            access_mode=d.get("access_mode"),
            capacity_bytes=d.get("capacity_bytes"),
            status=d.get("status"),
            service_id=d.get("service_id"),
            created_at=d.get("created_at"),
        )


@dataclass
class MeshRoute:
    id: str
    kind: str
    target_service_id: Optional[str]
    target_stack_id: Optional[str]
    cidr: Optional[str]
    port: Optional[float]
    principal_type: str
    principal_id: str
    expires_at: Optional[str]
    created_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "MeshRoute":
        return cls(
            id=d.get("id"),
            kind=d.get("kind"),
            target_service_id=d.get("target_service_id"),
            target_stack_id=d.get("target_stack_id"),
            cidr=d.get("cidr"),
            port=d.get("port"),
            principal_type=d.get("principal_type"),
            principal_id=d.get("principal_id"),
            expires_at=d.get("expires_at"),
            created_at=d.get("created_at"),
        )


@dataclass
class MeshConnect:
    driver: str
    address: str
    join_snippet: str
    setup_key: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "MeshConnect":
        return cls(
            driver=d.get("driver"),
            address=d.get("address"),
            join_snippet=d.get("join_snippet"),
            setup_key=d.get("setup_key"),
        )


@dataclass
class GrantMeshRouteResult:
    route: MeshRoute
    connect: MeshConnect

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "GrantMeshRouteResult":
        return cls(
            route=d.get("route"),
            connect=d.get("connect"),
        )

