"""HTTP transport for the swarmy client (hand-written, stable).

Uses the standard library only (``urllib``). The opener is injectable so it
can be mocked in tests.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional, Tuple

from .errors import SwarmyApiError
from .models import Problem

API_PREFIX = "/api/v1"
DEFAULT_ACCEPT = "application/json, application/problem+json"

# ``timeout`` default for ``stream``: block until the server sends or ends.
_BLOCK = None


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

    def _open(
        self,
        method: str,
        path: str,
        query: Optional[Dict[str, Any]],
        body: Optional[Any],
        accept: str,
        timeout: Optional[float],
    ) -> Any:
        """Send the request; return the open response or raise ``SwarmyApiError``."""
        url = self.build_url(path, query)
        data = None
        headers = {
            "Authorization": "Bearer {}".format(self.api_key),
            "Accept": accept,
        }
        headers.update(self.extra_headers)
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            return self._opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as exc:  # non-2xx
            raw = exc.read()
            problem = self._parse_problem(raw, exc.code, exc.reason)
            raise SwarmyApiError(exc.code, problem) from None

    def request(
        self,
        method: str,
        path: str,
        query: Optional[Dict[str, Any]] = None,
        body: Optional[Any] = None,
    ) -> Any:
        """Send a request and return the decoded JSON body (None when empty)."""
        resp = self._open(method, path, query, body, DEFAULT_ACCEPT, self.timeout)
        with resp:
            raw = resp.read()
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))

    def request_raw(
        self,
        method: str,
        path: str,
        query: Optional[Dict[str, Any]] = None,
        body: Optional[Any] = None,
        accept: str = DEFAULT_ACCEPT,
    ) -> Tuple[bytes, Any]:
        """Send a request and return ``(body bytes, response headers)`` undecoded,
        for endpoints that answer with something other than JSON (a CSV export)."""
        resp = self._open(method, path, query, body, accept, self.timeout)
        with resp:
            raw = resp.read()
            headers = getattr(resp, "headers", None) or {}
        return raw, headers

    def stream(
        self,
        method: str,
        path: str,
        query: Optional[Dict[str, Any]] = None,
        accept: str = "text/event-stream",
        timeout: Optional[float] = _BLOCK,
    ) -> Any:
        """Send a request and return the OPEN response for the caller to read
        incrementally (Server-Sent Events). ``timeout=None`` blocks on a quiet
        stream. Non-2xx responses still raise ``SwarmyApiError``. Close it when done."""
        return self._open(method, path, query, None, accept, timeout)

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


def header(headers: Any, name: str) -> Optional[str]:
    """A response header by case-insensitive name (``HTTPMessage`` or a plain dict)."""
    if headers is None:
        return None
    try:
        value = headers.get(name)
    except AttributeError:
        value = None
    if value is not None:
        return str(value)
    try:
        items = headers.items()
    except AttributeError:
        return None
    lower = name.lower()
    for key, val in items:
        if str(key).lower() == lower:
            return str(val)
    return None
