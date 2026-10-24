"""More resource groups for the swarmy client (hand-written, stable): API keys,
DNS, backups, volumes, audit, registry credentials, git, GitOps apps and
deployments."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from ._http import HttpTransport, header
from .models import (
    ApiKey,
    ApiKeyIssued,
    App,
    AppDeployResult,
    AppDrift,
    AppEnforceDrift,
    AppPlan,
    AppPromoteResult,
    AppRequireApproval,
    BackupRun,
    BackupTarget,
    ClusterVolume,
    ConfirmAppActionsResult,
    DeployEvents,
    DeploymentStatus,
    DnsDelegationCheck,
    DnsRecord,
    DnsZone,
    GitConnection,
    GitProviderBranch,
    GitProviderRepo,
    GitRemoved,
    GitRepo,
    LinkedGitRepo,
    PreviewResult,
    PurgeAppDataResult,
    RegistryCredential,
    RegistryCredentialDeleted,
    RegistryTestResult,
    Removed,
    RestoreResult,
    Revoked,
    Snapshot,
)
from .resources import _UNSET, _compact, _quote


def _page(body: Dict[str, Any], model: Any) -> Tuple[List[Any], Optional[str]]:
    return [model.from_dict(x) for x in body["data"]], body.get("next_cursor")


@dataclass
class AuditExport:
    """An audit-log export: the body as served (CSV or a JSON array), its
    content type, the row count, and whether the 10 000-row cap cut it short."""

    content: str
    content_type: str
    row_count: int
    truncated: bool


class ApiKeysResource:
    """API keys: what a script, CI job or the Terraform provider authenticates with."""

    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def list(self) -> Tuple[List[ApiKey], Optional[str]]:
        """The org's API keys (never the secret)."""
        return _page(self._http.request("GET", "/api-keys"), ApiKey)

    def create(
        self,
        name: str,
        preset: Optional[str] = None,
        scopes: Optional[List[str]] = None,
        stack_names: Optional[List[str]] = None,
        expiry: Optional[str] = None,
    ) -> ApiKeyIssued:
        """Mint a key. ``preset`` (``read``/``deploy``/``admin``) wins over ``scopes``;
        ``stack_names`` limits it to those apps (default: every app); ``expiry``
        is ``30d``/``90d``/``1y``/``never``. The plaintext ``key`` is returned ONCE."""
        payload = _compact(
            {"name": name, "preset": preset, "scopes": scopes, "stack_names": stack_names, "expiry": expiry}
        )
        return ApiKeyIssued.from_dict(self._http.request("POST", "/api-keys", body=payload))

    def revoke(self, key_id: str) -> Revoked:
        """Revoke a key: it authenticates nothing from now on."""
        return Revoked.from_dict(self._http.request("DELETE", "/api-keys/{}".format(_quote(key_id))))


class DnsResource:
    """swarmy-served DNS zones and their manual records."""

    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def list_zones(self) -> Tuple[List[DnsZone], Optional[str]]:
        return _page(self._http.request("GET", "/dns/zones"), DnsZone)

    def create_zone(self, zone: str, mode: Optional[str] = None) -> DnsZone:
        """Serve a zone (``mode``: ``swarmy-ns``, ``cloudflare`` or ``route53``)."""
        return DnsZone.from_dict(self._http.request("POST", "/dns/zones", body=_compact({"zone": zone, "mode": mode})))

    def remove_zone(self, zone_id: str) -> Removed:
        return Removed.from_dict(self._http.request("DELETE", "/dns/zones/{}".format(_quote(zone_id))))

    def delegation(self, zone_id: str) -> DnsDelegationCheck:
        """Whether the registrar delegates the zone to swarmy's nameservers."""
        return DnsDelegationCheck.from_dict(
            self._http.request("GET", "/dns/zones/{}/delegation".format(_quote(zone_id)))
        )

    def list_records(self, zone_id: str) -> Tuple[List[DnsRecord], Optional[str]]:
        """The zone's manual records (MX/TXT/CNAME/…)."""
        return _page(self._http.request("GET", "/dns/zones/{}/records".format(_quote(zone_id))), DnsRecord)

    def upsert_record(
        self,
        zone_id: str,
        name: str,
        type: str,
        value: str,
        ttl: Optional[int] = None,
        priority: Optional[int] = None,
    ) -> DnsRecord:
        """Create or update a manual record (upsert by name + type + value).
        ``priority`` is for MX/SRV; ``0`` is sent."""
        payload = _compact({"name": name, "type": type, "value": value, "ttl": ttl, "priority": priority})
        return DnsRecord.from_dict(
            self._http.request("POST", "/dns/zones/{}/records".format(_quote(zone_id)), body=payload)
        )

    def remove_record(self, record_id: str) -> Removed:
        return Removed.from_dict(self._http.request("DELETE", "/dns/records/{}".format(_quote(record_id))))


class BackupsResource:
    """Backup targets (restic repos) and volume snapshots."""

    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def list_targets(self) -> Tuple[List[BackupTarget], Optional[str]]:
        return _page(self._http.request("GET", "/backup-targets"), BackupTarget)

    def add_target(
        self,
        name: str,
        kind: str,
        bucket: str,
        endpoint: Optional[str] = None,
        prefix: Optional[str] = None,
        region: Optional[str] = None,
        access_key_id: Optional[str] = None,
        secret_access_key: Optional[str] = None,
        restic_password: Optional[str] = None,
    ) -> BackupTarget:
        """Add a restic repository (``kind``: ``s3`` or ``node``)."""
        payload = _compact(
            {
                "name": name,
                "kind": kind,
                "endpoint": endpoint,
                "bucket": bucket,
                "prefix": prefix,
                "region": region,
                "access_key_id": access_key_id,
                "secret_access_key": secret_access_key,
                "restic_password": restic_password,
            }
        )
        return BackupTarget.from_dict(self._http.request("POST", "/backup-targets", body=payload))

    def remove_target(self, target_id: str) -> Removed:
        return Removed.from_dict(self._http.request("DELETE", "/backup-targets/{}".format(_quote(target_id))))

    def list_snapshots(
        self, volume: Optional[str] = None, target_id: Optional[str] = None
    ) -> Tuple[List[Snapshot], Optional[str]]:
        """Snapshots, optionally of one volume and/or in one target."""
        body = self._http.request("GET", "/snapshots", query={"volume": volume, "target_id": target_id})
        return _page(body, Snapshot)

    def backup_volume(self, target_id: str, volume: str, node_id: Optional[str] = None) -> BackupRun:
        """Back up a volume now (creates a snapshot)."""
        payload = _compact({"target_id": target_id, "volume": volume, "node_id": node_id})
        return BackupRun.from_dict(self._http.request("POST", "/snapshots", body=payload))

    def restore_snapshot(
        self, snapshot_id: str, target_volume: Optional[str] = None, node_id: Optional[str] = None
    ) -> RestoreResult:
        """Restore a snapshot into ``target_volume`` (default: the volume it came from)."""
        payload = _compact({"snapshot_id": snapshot_id, "target_volume": target_volume, "node_id": node_id})
        return RestoreResult.from_dict(self._http.request("POST", "/snapshots/restore", body=payload))


class VolumesResource:
    """Cluster (CSI) volumes."""

    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def list(self) -> Tuple[List[ClusterVolume], Optional[str]]:
        return _page(self._http.request("GET", "/volumes"), ClusterVolume)

    def register(
        self,
        name: str,
        csi_driver: str,
        access_mode: Optional[str] = None,
        capacity_bytes: Optional[int] = None,
        options: Optional[Dict[str, str]] = None,
        service_id: Optional[str] = None,
    ) -> ClusterVolume:
        """Register and provision a cluster volume."""
        payload = _compact(
            {
                "name": name,
                "csi_driver": csi_driver,
                "access_mode": access_mode,
                "capacity_bytes": capacity_bytes,
                "options": options,
                "service_id": service_id,
            }
        )
        return ClusterVolume.from_dict(self._http.request("POST", "/volumes", body=payload))

    def remove(self, volume_id: str) -> Removed:
        """Deregister a cluster volume."""
        return Removed.from_dict(self._http.request("DELETE", "/volumes/{}".format(_quote(volume_id))))


class AuditResource:
    """The org's audit log."""

    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def export(
        self,
        actor: Optional[str] = None,
        actor_type: Optional[str] = None,
        action: Optional[str] = None,
        resource_type: Optional[str] = None,
        resource_id: Optional[str] = None,
        from_: Optional[str] = None,
        to: Optional[str] = None,
        format: Optional[str] = None,
    ) -> AuditExport:
        """Export the filtered audit trail (max 10 000 rows) as CSV (default) or
        JSON (``format="json"``). ``action`` is a prefix (``secrets.``); ``from_``
        and ``to`` are ISO dates/datetimes. The body is returned as text."""
        query = {
            "actor": actor,
            "actor_type": actor_type,
            "action": action,
            "resource_type": resource_type,
            "resource_id": resource_id,
            "from": from_,
            "to": to,
            "format": format,
        }
        raw, headers = self._http.request_raw(
            "GET", "/audit/export", query=query, accept="text/csv, application/json, application/problem+json"
        )
        rows = header(headers, "X-Swarmy-Row-Count")
        return AuditExport(
            content=raw.decode("utf-8"),
            content_type=header(headers, "Content-Type") or "",
            row_count=int(rows) if rows else 0,
            truncated=(header(headers, "X-Swarmy-Truncated") or "").lower() == "true",
        )


class RegistryCredentialsResource:
    """Logins for private image registries (secrets are never returned)."""

    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def list(self) -> Tuple[List[RegistryCredential], Optional[str]]:
        return _page(self._http.request("GET", "/registry-credentials"), RegistryCredential)

    def create(
        self,
        prefix: str,
        username: str,
        secret: str,
        provider: Optional[str] = None,
        label: Optional[str] = None,
    ) -> RegistryCredential:
        """Store a login for images under ``prefix`` (or rotate the login of an existing prefix)."""
        payload = _compact(
            {"prefix": prefix, "username": username, "secret": secret, "provider": provider, "label": label}
        )
        return RegistryCredential.from_dict(self._http.request("POST", "/registry-credentials", body=payload))

    def update(
        self,
        credential_id: str,
        username: Optional[str] = None,
        secret: Optional[str] = None,
        provider: Optional[str] = None,
        label: Any = _UNSET,
    ) -> RegistryCredential:
        """Change the username, provider or label, or rotate the secret; the
        arguments not given are kept. ``label=None`` clears the label."""
        payload = _compact({"username": username, "secret": secret, "provider": provider})
        if label is not _UNSET:
            payload["label"] = label
        return RegistryCredential.from_dict(
            self._http.request("PATCH", "/registry-credentials/{}".format(_quote(credential_id)), body=payload)
        )

    def remove(self, credential_id: str) -> RegistryCredentialDeleted:
        return RegistryCredentialDeleted.from_dict(
            self._http.request("DELETE", "/registry-credentials/{}".format(_quote(credential_id)))
        )

    def test(self, credential_id: str, image: Optional[str] = None) -> RegistryTestResult:
        """Log in to the registry with the stored credential (and HEAD ``image``'s manifest when given)."""
        return RegistryTestResult.from_dict(
            self._http.request(
                "POST", "/registry-credentials/{}/test".format(_quote(credential_id)), body=_compact({"image": image})
            )
        )


class GitResource:
    """Git provider connections and linked repositories. Only token-based
    connections (GitLab token, Gitea, generic) can be created over the API;
    GitHub App and GitLab OAuth need the dashboard."""

    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def list_connections(self) -> Tuple[List[GitConnection], Optional[str]]:
        """The org's git provider connections (no credentials)."""
        return _page(self._http.request("GET", "/git/connections"), GitConnection)

    def get_connection(self, connection_id: str) -> GitConnection:
        return GitConnection.from_dict(
            self._http.request("GET", "/git/connections/{}".format(_quote(connection_id)))
        )

    def create_connection(
        self,
        kind: str,
        mode: Optional[str] = None,
        base_url: Optional[str] = None,
        display_name: Optional[str] = None,
        token: Optional[str] = None,
        token_user: Optional[str] = None,
    ) -> GitConnection:
        """Connect a GitLab (token), Gitea or generic git host."""
        payload = _compact(
            {
                "kind": kind,
                "mode": mode,
                "base_url": base_url,
                "display_name": display_name,
                "token": token,
                "token_user": token_user,
            }
        )
        return GitConnection.from_dict(self._http.request("POST", "/git/connections", body=payload))

    def remove_connection(self, connection_id: str) -> GitRemoved:
        return GitRemoved.from_dict(
            self._http.request("DELETE", "/git/connections/{}".format(_quote(connection_id)))
        )

    def list_provider_repos(
        self, connection_id: str, search: Optional[str] = None
    ) -> Tuple[List[GitProviderRepo], Optional[str]]:
        """Repositories the connection can see (the provider's repo picker)."""
        body = self._http.request(
            "GET", "/git/connections/{}/repos".format(_quote(connection_id)), query={"search": search}
        )
        return _page(body, GitProviderRepo)

    def list_provider_branches(
        self, connection_id: str, repo: str
    ) -> Tuple[List[GitProviderBranch], Optional[str]]:
        """Branches of a provider repository (``repo`` is its full name or id)."""
        body = self._http.request(
            "GET", "/git/connections/{}/branches".format(_quote(connection_id)), query={"repo": repo}
        )
        return _page(body, GitProviderBranch)

    def list_repos(self) -> Tuple[List[GitRepo], Optional[str]]:
        """The org's linked repositories (no secrets)."""
        return _page(self._http.request("GET", "/git/repos"), GitRepo)

    def get_repo(self, repo_id: str) -> GitRepo:
        return GitRepo.from_dict(self._http.request("GET", "/git/repos/{}".format(_quote(repo_id))))

    def link_repo(
        self,
        branch: str,
        connection_id: Optional[str] = None,
        repo: Optional[Dict[str, str]] = None,
        url: Optional[str] = None,
        config_path: Optional[str] = None,
        deploy_key: Optional[bool] = None,
    ) -> LinkedGitRepo:
        """Link a repository as an app: through a connection (``connection_id`` +
        ``repo`` = ``{"id", "full_name", "clone_url"}``) or by ``url``. The webhook
        secret and deploy-key public half in the result are returned ONCE."""
        payload = _compact(
            {
                "connection_id": connection_id,
                "repo": repo,
                "url": url,
                "branch": branch,
                "config_path": config_path,
                "deploy_key": deploy_key,
            }
        )
        return LinkedGitRepo.from_dict(self._http.request("POST", "/git/repos", body=payload))

    def update_repo(
        self, repo_id: str, branch: Optional[str] = None, config_path: Optional[str] = None
    ) -> GitRepo:
        """Change a linked repository's branch and/or swarmy.yaml path in place."""
        payload = _compact({"branch": branch, "config_path": config_path})
        return GitRepo.from_dict(self._http.request("PATCH", "/git/repos/{}".format(_quote(repo_id)), body=payload))

    def remove_repo(self, repo_id: str) -> GitRemoved:
        """Unlink a repository."""
        return GitRemoved.from_dict(self._http.request("DELETE", "/git/repos/{}".format(_quote(repo_id))))


class AppsResource:
    """GitOps apps (linked repositories): plans per environment, confirming held
    steps, the require-approval and enforce-drift toggles, deploy-now, drift,
    promotion and previews."""

    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def list(self) -> Tuple[List[App], Optional[str]]:
        """Every app with each environment's latest plan."""
        return _page(self._http.request("GET", "/apps"), App)

    def find(self, ref: str) -> Optional[App]:
        """One app by repo id, app name, repo full name or repo URL (None when no match)."""
        apps, _ = self.list()
        for app in apps:
            if ref in (app.repo_id, app.app_name, app.full_name, app.url):
                return app
        return None

    def plans(
        self, repo_id: str, environment: Optional[str] = None, limit: Optional[int] = None
    ) -> Tuple[List[AppPlan], Optional[str]]:
        """An app's plans, newest first."""
        body = self._http.request(
            "GET", "/apps/{}/plans".format(_quote(repo_id)), query={"environment": environment, "limit": limit}
        )
        return _page(body, AppPlan)

    def plan(self, plan_id: str) -> AppPlan:
        return AppPlan.from_dict(self._http.request("GET", "/apps/plans/{}".format(_quote(plan_id))))

    def confirm(self, plan_id: str, action_ids: List[str]) -> ConfirmAppActionsResult:
        """Confirm held steps of a plan by id, then apply them. A step the caller
        may not confirm fails the call (403)."""
        return ConfirmAppActionsResult.from_dict(
            self._http.request(
                "POST", "/apps/plans/{}/confirm".format(_quote(plan_id)), body={"action_ids": action_ids}
            )
        )

    def set_require_approval(self, repo_id: str, require: bool) -> AppRequireApproval:
        """Toggle "every step waits for confirmation" for the app."""
        return AppRequireApproval.from_dict(
            self._http.request(
                "PUT", "/apps/{}/require-approval".format(_quote(repo_id)), body={"require_approval": require}
            )
        )

    def deploy(self, repo_id: str, branch: Optional[str] = None) -> AppDeployResult:
        """Plan and apply the head of ``branch`` now (default: the production branch)."""
        return AppDeployResult.from_dict(
            self._http.request("POST", "/apps/{}/deploy".format(_quote(repo_id)), body=_compact({"branch": branch}))
        )

    def drift(self, repo_id: str) -> Tuple[List[AppDrift], Optional[str]]:
        """Compare each environment's last applied commit with live state (changes nothing)."""
        return _page(self._http.request("GET", "/apps/{}/drift".format(_quote(repo_id))), AppDrift)

    def set_enforce_drift(self, repo_id: str, enforce: bool) -> AppEnforceDrift:
        """Opt the app in (or out) of re-applying drift on git-owned fields."""
        return AppEnforceDrift.from_dict(
            self._http.request(
                "PUT", "/apps/{}/enforce-drift".format(_quote(repo_id)), body={"enforce_drift": enforce}
            )
        )

    def purge_data(self, repo_id: str, environment: str, resource: str, confirm: str) -> PurgeAppDataResult:
        """Permanently delete a REMOVED managed Postgres's volumes on every node.
        ``confirm`` must be exactly ``"<stack>/<resource>"``. Irreversible."""
        return PurgeAppDataResult.from_dict(
            self._http.request(
                "POST",
                "/apps/{}/environments/{}/purge".format(_quote(repo_id), _quote(environment)),
                body={"resource": resource, "confirm": confirm},
            )
        )

    def promote(self, repo_id: str, from_: str) -> AppPromoteResult:
        """Plan production with the image digests the ``from_`` environment
        (e.g. ``"staging"``) runs now — no rebuild, same gates."""
        return AppPromoteResult.from_dict(
            self._http.request("POST", "/apps/{}/promote".format(_quote(repo_id)), body={"from": from_})
        )

    def preview(self, repo_id: str, branch: str) -> PreviewResult:
        """Build ``branch`` and deploy it as a preview stack (a trial deploy)."""
        return PreviewResult.from_dict(
            self._http.request("POST", "/apps/{}/previews".format(_quote(repo_id)), body={"branch": branch})
        )


class DeploymentsResource:
    """Following an async deploy (a 202's ``DeploymentRef``) to its end."""

    def __init__(self, http: HttpTransport) -> None:
        self._http = http

    def get(self, deployment_id: str) -> DeploymentStatus:
        """A deployment's convergence; poll until ``phase`` is terminal."""
        return DeploymentStatus.from_dict(
            self._http.request("GET", "/deployments/{}".format(_quote(deployment_id)))
        )

    def events(self, deploy_id: str) -> DeployEvents:
        """A stack deploy's progress events (poll while ``done`` is false)."""
        return DeployEvents.from_dict(self._http.request("GET", "/deploys/{}/events".format(_quote(deploy_id))))
