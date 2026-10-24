package client

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ---- Deployments (GET /deployments/{id}, GET /deploys/{id}/events) ----
//
// Async mutations (create/scale/restart a service, deploy a stack) answer 202
// with a DeploymentRef. WaitForDeployment turns that into a blocking call: it
// polls the deployment until it reaches a terminal phase, the context ends, or
// the controller says something non-retryable.

// Deployment phases the API documents as terminal. Phase is an open set: any
// value not listed here is treated as still in progress.
const (
	PhaseComplete   = "complete"
	PhaseFailed     = "failed"
	PhaseRolledBack = "rolledback"
	PhaseCanceled   = "canceled"
)

// stackDeploymentPrefix marks a whole-stack deployment id (`stack:<name>`).
const stackDeploymentPrefix = "stack:"

// Default polling knobs for WaitForDeployment.
const (
	DefaultPollInterval  = 3 * time.Second
	DefaultNotFoundGrace = 2 * time.Minute
	// detailTimeout bounds the best-effort reads that explain a failure; they
	// run on a fresh context because the wait's own context may have expired.
	detailTimeout = 10 * time.Second
	// maxDetails caps how many failure lines an error carries.
	maxDetails = 5
)

// Succeeded reports whether the deployment converged.
func (s *DeploymentStatus) Succeeded() bool { return s != nil && s.Phase == PhaseComplete }

// Failed reports whether the deployment reached a terminal failure phase.
func (s *DeploymentStatus) Failed() bool {
	if s == nil {
		return false
	}
	switch s.Phase {
	case PhaseFailed, PhaseRolledBack, PhaseCanceled:
		return true
	}
	return false
}

// GetDeployment reads a deployment's convergence.
func (c *Client) GetDeployment(ctx context.Context, id string) (*DeploymentStatus, error) {
	var s DeploymentStatus
	if err := c.get(ctx, "/deployments/"+url.PathEscape(id), &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// GetDeployEvents reads a traced deploy's events (kept 30 min after the last).
func (c *Client) GetDeployEvents(ctx context.Context, deployID string) (*DeployEvents, error) {
	var e DeployEvents
	if err := c.get(ctx, "/deploys/"+url.PathEscape(deployID)+"/events", &e); err != nil {
		return nil, err
	}
	return &e, nil
}

// WaitOptions tunes WaitForDeployment. Zero values pick the defaults.
type WaitOptions struct {
	// PollInterval is the delay between polls (default DefaultPollInterval).
	PollInterval time.Duration
	// NotFoundGrace is how long a 404 counts as "not visible yet" — the live
	// inventory lags a dispatch by a few seconds (default DefaultNotFoundGrace).
	NotFoundGrace time.Duration
}

// DeploymentError is returned when a deployment fails, vanishes, or does not
// reach a terminal phase before the context ends.
type DeploymentError struct {
	DeploymentID string
	// Status is the last status seen (nil if the deployment never answered).
	Status *DeploymentStatus
	// TimedOut is set when the context ended before a terminal phase.
	TimedOut bool
	// Waited is how long the wait ran.
	Waited time.Duration
	// Cause is the last poll error, when the final poll did not answer.
	Cause error
	// Details are best-effort explanations: the service's last task error and
	// any failed deploy events.
	Details []string
}

func (e *DeploymentError) Error() string {
	var b strings.Builder
	switch {
	case e.TimedOut:
		fmt.Fprintf(&b, "timed out after %s waiting for deployment %s", e.Waited.Round(time.Second), e.DeploymentID)
	case e.Status != nil && e.Status.Failed():
		fmt.Fprintf(&b, "deployment %s %s", e.DeploymentID, e.Status.Phase)
	case e.Cause != nil && IsNotFound(e.Cause):
		fmt.Fprintf(&b, "deployment %s not found", e.DeploymentID)
	default:
		fmt.Fprintf(&b, "deployment %s did not complete", e.DeploymentID)
	}
	if s := e.Status; s != nil {
		parts := []string{"last phase " + s.Phase}
		if s.Ready != nil && s.Desired != nil {
			parts = append(parts, fmt.Sprintf("%d/%d ready", *s.Ready, *s.Desired))
		}
		fmt.Fprintf(&b, " (%s)", strings.Join(parts, ", "))
		if s.Message != nil && *s.Message != "" {
			b.WriteString(": " + *s.Message)
		}
	}
	if e.Cause != nil && !IsNotFound(e.Cause) {
		b.WriteString("; last poll error: " + e.Cause.Error())
	}
	for _, d := range e.Details {
		b.WriteString("\n  - " + d)
	}
	return b.String()
}

func (e *DeploymentError) Unwrap() error { return e.Cause }

// WaitForDeployment polls the deployment behind ref until it reaches a
// terminal phase. It returns the final status on "complete"; otherwise a
// *DeploymentError (failed phase, persistent 404, or ctx deadline) or the
// non-retryable API error that stopped it. Bound the wait with ctx.
func (c *Client) WaitForDeployment(ctx context.Context, ref DeploymentRef, opts WaitOptions) (*DeploymentStatus, error) {
	id := ref.DeploymentID
	if id == "" {
		// Scale/restart answer an empty deployment_id: the service id polls the
		// same convergence.
		id = ref.ID
	}
	if id == "" {
		return nil, errors.New("the API returned no deployment id to wait on")
	}
	interval := opts.PollInterval
	if interval <= 0 {
		interval = DefaultPollInterval
	}
	grace := opts.NotFoundGrace
	if grace <= 0 {
		grace = DefaultNotFoundGrace
	}

	start := time.Now()
	var last *DeploymentStatus
	var lastErr error
	fail := func(timedOut bool) error {
		de := &DeploymentError{DeploymentID: id, Status: last, TimedOut: timedOut, Waited: time.Since(start), Cause: lastErr}
		de.Details = c.explainDeployment(ctx, ref, id, last)
		return de
	}

	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return last, fail(true)
		case <-timer.C:
		}

		st, err := c.GetDeployment(ctx, id)
		switch {
		case err == nil:
			last, lastErr = st, nil
			if st.Succeeded() {
				return st, nil
			}
			if st.Failed() {
				return st, fail(false)
			}
		case ctx.Err() != nil:
			// The deadline hit mid-request.
			return last, fail(true)
		case IsNotFound(err):
			lastErr = err
			if time.Since(start) >= grace {
				return last, fail(false)
			}
		case isRetryable(err):
			lastErr = err
		default:
			return last, fmt.Errorf("polling deployment %s: %w", id, err)
		}
		timer.Reset(interval)
	}
}

// isRetryable reports whether a poll error is transient: a 429/5xx answer or
// a transport failure (no HTTP answer at all).
func isRetryable(err error) bool {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.StatusCode == http.StatusTooManyRequests || apiErr.StatusCode >= 500
	}
	return true
}

// explainDeployment gathers best-effort reasons a deployment did not finish:
// the service's last Swarm task error, and the failed steps of a traced
// deploy. It uses its own short context, since the wait's may be spent.
func (c *Client) explainDeployment(ctx context.Context, ref DeploymentRef, id string, last *DeploymentStatus) []string {
	dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), detailTimeout)
	defer cancel()

	var out []string
	seen := map[string]bool{}
	add := func(s string) {
		if s == "" || seen[s] || len(out) >= maxDetails {
			return
		}
		seen[s] = true
		out = append(out, s)
	}

	serviceID := ""
	if last != nil && last.ServiceID != nil {
		serviceID = *last.ServiceID
	} else if !strings.HasPrefix(id, stackDeploymentPrefix) {
		serviceID = ref.ID
	}
	if serviceID != "" {
		if svc, err := c.GetService(dctx, serviceID); err == nil && svc.LastError != nil && *svc.LastError != "" {
			add(fmt.Sprintf("service %s: %s", svc.Name, *svc.LastError))
		}
	}

	if ref.DeployID != "" {
		if ev, err := c.GetDeployEvents(dctx, ref.DeployID); err == nil {
			// Most recent failures first.
			for i := len(ev.Data) - 1; i >= 0; i-- {
				e := ev.Data[i]
				if e.Status != "failed" {
					continue
				}
				where := e.Stage
				if e.Node != "" {
					where += " on " + e.Node
				}
				add(where + ": " + e.Message)
			}
		}
	}
	return out
}
