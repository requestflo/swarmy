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
class GitRepoWebhook:
    url: str
    secret: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "GitRepoWebhook":
        return cls(
            url=d.get("url"),
            secret=d.get("secret"),
        )


@dataclass
class GitRepoRef:
    id: str
    full_name: str
    clone_url: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "GitRepoRef":
        return cls(
            id=d.get("id"),
            full_name=d.get("full_name"),
            clone_url=d.get("clone_url"),
        )


@dataclass
class AppPreviewData:
    from: str
    scrub: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AppPreviewData":
        return cls(
            from=d.get("from"),
            scrub=d.get("scrub"),
        )


@dataclass
class AppDriftCheck:
    checked_at: str
    environments: List[AppDrift]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AppDriftCheck":
        return cls(
            checked_at=d.get("checked_at"),
            environments=d.get("environments"),
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
    last_error: Optional[str] = None

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
            last_error=d.get("last_error"),
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
class IngressDomainStatus:
    host: str
    state: str
    reason: str
    warnings: List[str]
    gated: bool
    verified_at: Optional[str]
    verified_manually: bool
    last_checked_at: Optional[str]
    next_check_at: Optional[str]
    dns: Optional[Dict[str, Any]]
    certificate: Optional[Dict[str, Any]]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "IngressDomainStatus":
        return cls(
            host=d.get("host"),
            state=d.get("state"),
            reason=d.get("reason"),
            warnings=d.get("warnings"),
            gated=d.get("gated"),
            verified_at=d.get("verified_at"),
            verified_manually=d.get("verified_manually"),
            last_checked_at=d.get("last_checked_at"),
            next_check_at=d.get("next_check_at"),
            dns=d.get("dns"),
            certificate=d.get("certificate"),
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
    www: Optional[str] = None
    companion_host: Optional[str] = None
    auto: Optional[bool] = None
    status: Optional[IngressDomainStatus] = None
    companion_status: Optional[IngressDomainStatus] = None

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
            www=d.get("www"),
            companion_host=d.get("companion_host"),
            auto=d.get("auto"),
            status=d.get("status"),
            companion_status=d.get("companion_status"),
        )


@dataclass
class DnsRecordHint:
    type: str
    name: str
    label: str
    value: str
    note: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "DnsRecordHint":
        return cls(
            type=d.get("type"),
            name=d.get("name"),
            label=d.get("label"),
            value=d.get("value"),
            note=d.get("note"),
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
class DnsZone:
    id: str
    zone: str
    mode: str
    enabled: bool
    ttl: int
    serial: int
    apex_to_edge: bool
    auto_www: bool
    nameservers: List[Dict[str, Any]]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "DnsZone":
        return cls(
            id=d.get("id"),
            zone=d.get("zone"),
            mode=d.get("mode"),
            enabled=d.get("enabled"),
            ttl=d.get("ttl"),
            serial=d.get("serial"),
            apex_to_edge=d.get("apex_to_edge"),
            auto_www=d.get("auto_www"),
            nameservers=d.get("nameservers"),
        )


@dataclass
class DnsDelegationCheck:
    zone: str
    delegated: bool
    public_ns: List[str]
    nameservers: List[Dict[str, Any]]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "DnsDelegationCheck":
        return cls(
            zone=d.get("zone"),
            delegated=d.get("delegated"),
            public_ns=d.get("public_ns"),
            nameservers=d.get("nameservers"),
        )


@dataclass
class DnsRecord:
    id: str
    zone_id: str
    name: str
    type: str
    value: str
    ttl: Optional[int]
    priority: Optional[int]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "DnsRecord":
        return cls(
            id=d.get("id"),
            zone_id=d.get("zone_id"),
            name=d.get("name"),
            type=d.get("type"),
            value=d.get("value"),
            ttl=d.get("ttl"),
            priority=d.get("priority"),
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
class NotifyQueued:
    queued: bool
    to: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "NotifyQueued":
        return cls(
            queued=d.get("queued"),
            to=d.get("to"),
        )


@dataclass
class NotifyBody:
    to: str
    subject: str
    body: Optional[str] = None
    html: Optional[str] = None
    template: Optional[str] = None
    vars: Optional[Dict[str, Any]] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "NotifyBody":
        return cls(
            to=d.get("to"),
            subject=d.get("subject"),
            body=d.get("body"),
            html=d.get("html"),
            template=d.get("template"),
            vars=d.get("vars"),
        )


@dataclass
class RegistryCredential:
    id: str
    prefix: str
    provider: str
    label: Optional[str]
    username: str
    has_secret: bool
    last_tested_at: Optional[str]
    last_test_ok: Optional[bool]
    last_test_message: Optional[str]
    created_at: str
    updated_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "RegistryCredential":
        return cls(
            id=d.get("id"),
            prefix=d.get("prefix"),
            provider=d.get("provider"),
            label=d.get("label"),
            username=d.get("username"),
            has_secret=d.get("has_secret"),
            last_tested_at=d.get("last_tested_at"),
            last_test_ok=d.get("last_test_ok"),
            last_test_message=d.get("last_test_message"),
            created_at=d.get("created_at"),
            updated_at=d.get("updated_at"),
        )


@dataclass
class CreateRegistryCredentialBody:
    prefix: str
    username: str
    secret: str
    provider: Optional[str] = None
    label: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "CreateRegistryCredentialBody":
        return cls(
            prefix=d.get("prefix"),
            username=d.get("username"),
            secret=d.get("secret"),
            provider=d.get("provider"),
            label=d.get("label"),
        )


@dataclass
class UpdateRegistryCredentialBody:
    username: Optional[str] = None
    secret: Optional[str] = None
    provider: Optional[str] = None
    label: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "UpdateRegistryCredentialBody":
        return cls(
            username=d.get("username"),
            secret=d.get("secret"),
            provider=d.get("provider"),
            label=d.get("label"),
        )


@dataclass
class RegistryCredentialDeleted:
    ok: bool

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "RegistryCredentialDeleted":
        return cls(
            ok=d.get("ok"),
        )


@dataclass
class RegistryTestResult:
    ok: bool
    status: str
    message: str
    checked_manifest: bool

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "RegistryTestResult":
        return cls(
            ok=d.get("ok"),
            status=d.get("status"),
            message=d.get("message"),
            checked_manifest=d.get("checked_manifest"),
        )


@dataclass
class TestRegistryCredentialBody:
    image: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "TestRegistryCredentialBody":
        return cls(
            image=d.get("image"),
        )


@dataclass
class GitConnection:
    id: str
    kind: str
    display_name: str
    base_url: str
    account: Optional[str]
    status: str
    repo_count: int
    created_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "GitConnection":
        return cls(
            id=d.get("id"),
            kind=d.get("kind"),
            display_name=d.get("display_name"),
            base_url=d.get("base_url"),
            account=d.get("account"),
            status=d.get("status"),
            repo_count=d.get("repo_count"),
            created_at=d.get("created_at"),
        )


@dataclass
class CreateGitConnectionBody:
    kind: str
    mode: Optional[str] = None
    base_url: Optional[str] = None
    display_name: Optional[str] = None
    token: Optional[str] = None
    token_user: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "CreateGitConnectionBody":
        return cls(
            kind=d.get("kind"),
            mode=d.get("mode"),
            base_url=d.get("base_url"),
            display_name=d.get("display_name"),
            token=d.get("token"),
            token_user=d.get("token_user"),
        )


@dataclass
class GitRemoved:
    id: str
    removed: bool

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "GitRemoved":
        return cls(
            id=d.get("id"),
            removed=d.get("removed"),
        )


@dataclass
class GitProviderRepo:
    id: str
    full_name: str
    clone_url: str
    html_url: str
    default_branch: str
    private: bool

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "GitProviderRepo":
        return cls(
            id=d.get("id"),
            full_name=d.get("full_name"),
            clone_url=d.get("clone_url"),
            html_url=d.get("html_url"),
            default_branch=d.get("default_branch"),
            private=d.get("private"),
        )


@dataclass
class GitProviderBranch:
    name: str
    sha: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "GitProviderBranch":
        return cls(
            name=d.get("name"),
            sha=d.get("sha"),
        )


@dataclass
class GitRepo:
    id: str
    kind: str
    url: str
    branch: str
    config_path: str
    connection_id: Optional[str]
    full_name: Optional[str]
    autodeploy: bool
    service_id: Optional[str]
    has_token: bool
    require_approval: bool
    enforce_drift: bool
    created_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "GitRepo":
        return cls(
            id=d.get("id"),
            kind=d.get("kind"),
            url=d.get("url"),
            branch=d.get("branch"),
            config_path=d.get("config_path"),
            connection_id=d.get("connection_id"),
            full_name=d.get("full_name"),
            autodeploy=d.get("autodeploy"),
            service_id=d.get("service_id"),
            has_token=d.get("has_token"),
            require_approval=d.get("require_approval"),
            enforce_drift=d.get("enforce_drift"),
            created_at=d.get("created_at"),
        )


@dataclass
class LinkedGitRepo:
    id: str
    url: str
    branch: str
    config_path: str
    full_name: Optional[str]
    webhook: Optional[GitRepoWebhook]
    deploy_key_public: Optional[str]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "LinkedGitRepo":
        return cls(
            id=d.get("id"),
            url=d.get("url"),
            branch=d.get("branch"),
            config_path=d.get("config_path"),
            full_name=d.get("full_name"),
            webhook=GitRepoWebhook.from_dict(d["webhook"]) if d.get("webhook") is not None else None,
            deploy_key_public=d.get("deploy_key_public"),
        )


@dataclass
class LinkGitRepoBody:
    branch: str
    connection_id: Optional[str] = None
    repo: Optional[GitRepoRef] = None
    url: Optional[str] = None
    config_path: Optional[str] = None
    deploy_key: Optional[bool] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "LinkGitRepoBody":
        return cls(
            connection_id=d.get("connection_id"),
            repo=GitRepoRef.from_dict(d["repo"]) if d.get("repo") is not None else None,
            url=d.get("url"),
            branch=d.get("branch"),
            config_path=d.get("config_path"),
            deploy_key=d.get("deploy_key"),
        )


@dataclass
class UpdateGitRepoBody:
    branch: Optional[str] = None
    config_path: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "UpdateGitRepoBody":
        return cls(
            branch=d.get("branch"),
            config_path=d.get("config_path"),
        )


@dataclass
class AppKeptVolumes:
    resource: str
    volumes: List[str]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AppKeptVolumes":
        return cls(
            resource=d.get("resource"),
            volumes=d.get("volumes"),
        )


@dataclass
class AppEnvironment:
    environment: str
    branch: str
    stack: str
    latest_plan_id: Optional[str]
    latest_plan_status: Optional[str]
    latest_sha: Optional[str]
    latest_created_at: Optional[str]
    kept_volumes: List[AppKeptVolumes]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AppEnvironment":
        return cls(
            environment=d.get("environment"),
            branch=d.get("branch"),
            stack=d.get("stack"),
            latest_plan_id=d.get("latest_plan_id"),
            latest_plan_status=d.get("latest_plan_status"),
            latest_sha=d.get("latest_sha"),
            latest_created_at=d.get("latest_created_at"),
            kept_volumes=d.get("kept_volumes"),
        )


@dataclass
class AppPreview:
    pr: int
    stack: str
    sha: str
    status: str
    url: Optional[str]
    updated_at: str
    plan_id: str
    branch: Optional[str] = None
    data: Optional[AppPreviewData] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AppPreview":
        return cls(
            pr=d.get("pr"),
            stack=d.get("stack"),
            sha=d.get("sha"),
            status=d.get("status"),
            url=d.get("url"),
            updated_at=d.get("updated_at"),
            plan_id=d.get("plan_id"),
            branch=d.get("branch"),
            data=AppPreviewData.from_dict(d["data"]) if d.get("data") is not None else None,
        )


@dataclass
class AppDrift:
    environment: str
    stack: str
    changes: int

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AppDrift":
        return cls(
            environment=d.get("environment"),
            stack=d.get("stack"),
            changes=d.get("changes"),
        )


@dataclass
class App:
    repo_id: str
    url: str
    full_name: Optional[str]
    branch: str
    config_path: str
    app_name: Optional[str]
    require_approval: bool
    enforce_drift: bool
    environments: List[AppEnvironment]
    previews: List[AppPreview]
    drift: Optional[AppDriftCheck]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "App":
        return cls(
            repo_id=d.get("repo_id"),
            url=d.get("url"),
            full_name=d.get("full_name"),
            branch=d.get("branch"),
            config_path=d.get("config_path"),
            app_name=d.get("app_name"),
            require_approval=d.get("require_approval"),
            enforce_drift=d.get("enforce_drift"),
            environments=d.get("environments"),
            previews=d.get("previews"),
            drift=AppDriftCheck.from_dict(d["drift"]) if d.get("drift") is not None else None,
        )


@dataclass
class AppPlanCounts:
    auto: int
    confirm: int
    blocked: int

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AppPlanCounts":
        return cls(
            auto=d.get("auto"),
            confirm=d.get("confirm"),
            blocked=d.get("blocked"),
        )


@dataclass
class AppPlanAction:
    id: str
    kind: str
    phase: int
    gate: str
    reason: str
    outcome: Optional[str]
    outcome_message: Optional[str]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AppPlanAction":
        return cls(
            id=d.get("id"),
            kind=d.get("kind"),
            phase=d.get("phase"),
            gate=d.get("gate"),
            reason=d.get("reason"),
            outcome=d.get("outcome"),
            outcome_message=d.get("outcome_message"),
        )


@dataclass
class AppConfigIssue:
    severity: str
    code: str
    message: str
    path: str
    line: Optional[int]
    col: Optional[int]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AppConfigIssue":
        return cls(
            severity=d.get("severity"),
            code=d.get("code"),
            message=d.get("message"),
            path=d.get("path"),
            line=d.get("line"),
            col=d.get("col"),
        )


@dataclass
class AppPlan:
    id: str
    repo_id: str
    environment: str
    stack: str
    sha: str
    trigger: str
    pr_number: Optional[int]
    status: str
    plan_status: Optional[str]
    counts: AppPlanCounts
    actions: List[AppPlanAction]
    issues: List[AppConfigIssue]
    error: Optional[str]
    confirmed_ids: List[str]
    markdown: str
    created_at: str
    applied_at: Optional[str]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AppPlan":
        return cls(
            id=d.get("id"),
            repo_id=d.get("repo_id"),
            environment=d.get("environment"),
            stack=d.get("stack"),
            sha=d.get("sha"),
            trigger=d.get("trigger"),
            pr_number=d.get("pr_number"),
            status=d.get("status"),
            plan_status=d.get("plan_status"),
            counts=d.get("counts"),
            actions=d.get("actions"),
            issues=d.get("issues"),
            error=d.get("error"),
            confirmed_ids=d.get("confirmed_ids"),
            markdown=d.get("markdown"),
            created_at=d.get("created_at"),
            applied_at=d.get("applied_at"),
        )


@dataclass
class ConfirmAppActionsResult:
    status: str
    confirmed: List[str]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ConfirmAppActionsResult":
        return cls(
            status=d.get("status"),
            confirmed=d.get("confirmed"),
        )


@dataclass
class ConfirmAppActionsBody:
    action_ids: List[str]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ConfirmAppActionsBody":
        return cls(
            action_ids=d.get("action_ids"),
        )


@dataclass
class AppRequireApproval:
    repo_id: str
    require_approval: bool

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AppRequireApproval":
        return cls(
            repo_id=d.get("repo_id"),
            require_approval=d.get("require_approval"),
        )


@dataclass
class SetRequireApprovalBody:
    require_approval: bool

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SetRequireApprovalBody":
        return cls(
            require_approval=d.get("require_approval"),
        )


@dataclass
class AppDeployResult:
    plan_id: Optional[str]
    status: str
    environment: Optional[str]
    stack: Optional[str]
    reason: Optional[str]
    plan: Optional[AppPlan]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AppDeployResult":
        return cls(
            plan_id=d.get("plan_id"),
            status=d.get("status"),
            environment=d.get("environment"),
            stack=d.get("stack"),
            reason=d.get("reason"),
            plan=d.get("plan"),
        )


@dataclass
class DeployAppBody:
    branch: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "DeployAppBody":
        return cls(
            branch=d.get("branch"),
        )


@dataclass
class AppEnforceDrift:
    repo_id: str
    enforce_drift: bool

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AppEnforceDrift":
        return cls(
            repo_id=d.get("repo_id"),
            enforce_drift=d.get("enforce_drift"),
        )


@dataclass
class SetEnforceDriftBody:
    enforce_drift: bool

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SetEnforceDriftBody":
        return cls(
            enforce_drift=d.get("enforce_drift"),
        )


@dataclass
class PurgeAppDataResult:
    stack: str
    resource: str
    volumes: List[str]
    nodes: int

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "PurgeAppDataResult":
        return cls(
            stack=d.get("stack"),
            resource=d.get("resource"),
            volumes=d.get("volumes"),
            nodes=d.get("nodes"),
        )


@dataclass
class PurgeAppDataBody:
    resource: str
    confirm: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "PurgeAppDataBody":
        return cls(
            resource=d.get("resource"),
            confirm=d.get("confirm"),
        )


@dataclass
class AppPromoteResult:
    plan_id: Optional[str]
    status: str
    environment: Optional[str]
    stack: Optional[str]
    reason: Optional[str]
    plan: Optional[AppPlan]
    images: Dict[str, Any]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "AppPromoteResult":
        return cls(
            plan_id=d.get("plan_id"),
            status=d.get("status"),
            environment=d.get("environment"),
            stack=d.get("stack"),
            reason=d.get("reason"),
            plan=d.get("plan"),
            images=d.get("images"),
        )


@dataclass
class PromoteAppBody:
    from: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "PromoteAppBody":
        return cls(
            from=d.get("from"),
        )


@dataclass
class Principal:
    org_id: str
    user: Dict[str, Any]
    role: str
    credential: Dict[str, Any]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Principal":
        return cls(
            org_id=d.get("org_id"),
            user=d.get("user"),
            role=d.get("role"),
            credential=d.get("credential"),
        )


@dataclass
class ServiceEnvVar:
    key: str
    value: Optional[str]
    secret: bool
    delivery: Optional[str]
    withheld: bool
    error: Optional[str]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ServiceEnvVar":
        return cls(
            key=d.get("key"),
            value=d.get("value"),
            secret=d.get("secret"),
            delivery=d.get("delivery"),
            withheld=d.get("withheld"),
            error=d.get("error"),
        )


@dataclass
class ServiceEnv:
    service_id: str
    service: str
    vars: List[ServiceEnvVar]
    secrets_readable: bool

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ServiceEnv":
        return cls(
            service_id=d.get("service_id"),
            service=d.get("service"),
            vars=d.get("vars"),
            secrets_readable=d.get("secrets_readable"),
        )


@dataclass
class PatchServiceEnvResult:
    id: str
    deployment_id: str
    changed: List[str]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "PatchServiceEnvResult":
        return cls(
            id=d.get("id"),
            deployment_id=d.get("deployment_id"),
            changed=d.get("changed"),
        )


@dataclass
class PatchServiceEnvBody:
    set: Optional[Dict[str, Any]] = None
    secrets: Optional[Dict[str, Any]] = None
    unset: Optional[List[str]] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "PatchServiceEnvBody":
        return cls(
            set=d.get("set"),
            secrets=d.get("secrets"),
            unset=d.get("unset"),
        )


@dataclass
class LogLine:
    seq: int
    stream: str
    ts: Optional[float]
    message: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "LogLine":
        return cls(
            seq=d.get("seq"),
            stream=d.get("stream"),
            ts=d.get("ts"),
            message=d.get("message"),
        )


@dataclass
class DeploymentStatus:
    deployment_id: str
    service_id: Optional[str]
    kind: str
    phase: str
    desired: Optional[int]
    ready: Optional[int]
    message: Optional[str]
    started_at: str
    finished_at: Optional[str]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "DeploymentStatus":
        return cls(
            deployment_id=d.get("deployment_id"),
            service_id=d.get("service_id"),
            kind=d.get("kind"),
            phase=d.get("phase"),
            desired=d.get("desired"),
            ready=d.get("ready"),
            message=d.get("message"),
            started_at=d.get("started_at"),
            finished_at=d.get("finished_at"),
        )


@dataclass
class PreviewResult:
    action: str
    stack: Optional[str]
    url: Optional[str]
    reason: Optional[str]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "PreviewResult":
        return cls(
            action=d.get("action"),
            stack=d.get("stack"),
            url=d.get("url"),
            reason=d.get("reason"),
        )


@dataclass
class CreatePreviewBody:
    branch: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "CreatePreviewBody":
        return cls(
            branch=d.get("branch"),
        )


@dataclass
class StackTelemetry:
    stack: str
    enabled: bool

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "StackTelemetry":
        return cls(
            stack=d.get("stack"),
            enabled=d.get("enabled"),
        )


@dataclass
class SetStackTelemetryBody:
    enabled: bool

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SetStackTelemetryBody":
        return cls(
            enabled=d.get("enabled"),
        )


@dataclass
class ErrorProject:
    stack: str
    project_id: int
    dsn: str
    rate_limit_per_minute: int
    created_at: str
    rotated_at: Optional[str]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ErrorProject":
        return cls(
            stack=d.get("stack"),
            project_id=d.get("project_id"),
            dsn=d.get("dsn"),
            rate_limit_per_minute=d.get("rate_limit_per_minute"),
            created_at=d.get("created_at"),
            rotated_at=d.get("rotated_at"),
        )


@dataclass
class StackErrorsStatus:
    stack: str
    enabled: bool
    store_enabled: bool
    project: ErrorProject
    pending_redeploy: List[str]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "StackErrorsStatus":
        return cls(
            stack=d.get("stack"),
            enabled=d.get("enabled"),
            store_enabled=d.get("store_enabled"),
            project=d.get("project"),
            pending_redeploy=d.get("pending_redeploy"),
        )

