"""HTTP transport for the swarmy client (hand-written, stable).

Uses the standard library only (``urllib``). The opener is injectable so it
can be mocked in tests.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

from .errors import SwarmyApiError
from .models import Problem

API_PREFIX = "/api/v1"


class HttpTransport:
    def __init__(
        self,
        endpoint: str,
        api_key: str,
        opener: Optional[Any] = None,
        timeout: float = 30.0,
        headers: Optional[Dict[str, str]] = None,
    ) -> None:
        if not endpoint:
            raise ValueError("SwarmyClient: `endpoint` is required")
        if not api_key:
            raise ValueError("SwarmyClient: `api_key` is required")
        trimmed = endpoint.rstrip("/")
        self.base = trimmed if trimmed.endswith(API_PREFIX) else trimmed + API_PREFIX
        self.api_key = api_key
        self.timeout = timeout
        self.extra_headers = headers or {}
        # urllib OpenerDirector-like object; defaults to the module-level opener.
        self._opener = opener or urllib.request.build_opener()

    def build_url(self, path: str, query: Optional[Dict[str, Any]] = None) -> str:
        url = self.base + path
        if query:
            pairs = [(k, str(v)) for k, v in query.items() if v is not None]
            if pairs:
                url += "?" + urllib.parse.urlencode(pairs)
        return url

    def request(
        self,
        method: str,
        path: str,
        query: Optional[Dict[str, Any]] = None,
        body: Optional[Any] = None,
    ) -> Any:
        url = self.build_url(path, query)
        data = None
        headers = {
            "Authorization": "Bearer {}".format(self.api_key),
            "Accept": "application/json, application/problem+json",
        }
        headers.update(self.extra_headers)
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            resp = self._opener.open(req, timeout=self.timeout)
        except urllib.error.HTTPError as exc:  # non-2xx
            raw = exc.read()
            problem = self._parse_problem(raw, exc.code, exc.reason)
            raise SwarmyApiError(exc.code, problem) from None

        with resp:
            status = getattr(resp, "status", 200) or 200
            raw = resp.read()
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))

    @staticmethod
    def _parse_problem(raw: bytes, status: int, reason: Any) -> Problem:
        try:
            return Problem.from_dict(json.loads(raw.decode("utf-8")))
        except Exception:
            return Problem(
                type="about:blank",
                title=str(reason) if reason else "Error",
                status=status,
            )
