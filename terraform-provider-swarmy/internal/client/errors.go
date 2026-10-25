package client

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// Problem is the RFC 9457 problem+json payload returned by the swarmy REST API
// on error responses (Content-Type: application/problem+json).
type Problem struct {
	Type       string `json:"type"`
	Title      string `json:"title"`
	Status     int    `json:"status"`
	Detail     string `json:"detail,omitempty"`
	Instance   string `json:"instance,omitempty"`
	SwarmyCode string `json:"swarmy_code,omitempty"`
	// Violations lists the rules an admission refusal (412) broke: guardrails,
	// exposure, image policy or the platform network wall.
	Violations []Violation `json:"violations,omitempty"`
	// InvalidParams lists every field a validation 400 refused, and why.
	InvalidParams []InvalidParam `json:"invalid_params,omitempty"`
}

// InvalidParam is one refused field (the InvalidParam DTO): a dotted
// snake_case name (`tls.on_demand`) and the reason.
type InvalidParam struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// Violation is one admission rule a deploy broke (the GuardrailProblem DTO).
type Violation struct {
	Rule     string `json:"rule"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
	Resource string `json:"resource,omitempty"`
}

// APIError wraps a non-2xx HTTP response from the swarmy API. When the body was
// a problem+json document it is decoded into Problem; otherwise Problem is nil
// and RawBody holds the response text.
type APIError struct {
	StatusCode int
	Problem    *Problem
	RawBody    string
}

func (e *APIError) Error() string {
	if e.Problem != nil {
		msg := e.Problem.Title
		if len(e.Problem.InvalidParams) > 0 {
			// Each refused field on its own line (the detail says the same, run together).
			for _, p := range e.Problem.InvalidParams {
				msg += fmt.Sprintf("\n  - %s: %s", p.Name, strings.TrimSpace(p.Reason))
			}
		} else if e.Problem.Detail != "" {
			msg = fmt.Sprintf("%s: %s", e.Problem.Title, e.Problem.Detail)
		}
		for _, v := range e.Problem.Violations {
			msg += fmt.Sprintf("\n  - %s (%s): %s", v.Rule, v.Severity, strings.TrimSpace(v.Message))
		}
		if e.Problem.SwarmyCode != "" {
			return fmt.Sprintf("swarmy API error %d (%s): %s", e.StatusCode, e.Problem.SwarmyCode, msg)
		}
		return fmt.Sprintf("swarmy API error %d: %s", e.StatusCode, msg)
	}
	if e.RawBody != "" {
		return fmt.Sprintf("swarmy API error %d: %s", e.StatusCode, e.RawBody)
	}
	return fmt.Sprintf("swarmy API error %d: %s", e.StatusCode, http.StatusText(e.StatusCode))
}

// IsNotFound reports whether err is an APIError with HTTP 404. Resources use
// this to drop deleted objects from state on Read.
func IsNotFound(err error) bool {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.StatusCode == http.StatusNotFound
	}
	return false
}
