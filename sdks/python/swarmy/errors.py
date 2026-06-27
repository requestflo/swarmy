"""Error types for the swarmy client (hand-written, stable)."""

from __future__ import annotations

from .models import Problem


class SwarmyApiError(Exception):
    """Raised for any non-2xx response.

    Carries the parsed RFC 9457 ``application/problem+json`` document.
    """

    def __init__(self, status: int, problem: Problem) -> None:
        self.status = status
        self.problem = problem
        self.code = problem.swarmy_code
        message = problem.detail or problem.title or "swarmy API error {}".format(status)
        super().__init__(message)
