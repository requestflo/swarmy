package client

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeDeployAPI answers GET /deployments/{id} from a scripted list of
// (status, body) replies (the last one repeats), plus fixed service and
// deploy-event reads used to explain a failure.
type fakeDeployAPI struct {
	mu       sync.Mutex
	replies  []fakeReply
	polls    int
	paths    []string
	service  string // GET /services/{id} body; "" = 404
	events   string // GET /deploys/{id}/events body; "" = 404
	lastAuth string
}

type fakeReply struct {
	status int
	body   string
}

// status is a 200 DeploymentStatus reply in the given phase.
func status(phase string, ready, desired int, msg string) fakeReply {
	var message any
	if msg != "" {
		message = msg
	}
	b, _ := json.Marshal(map[string]any{
		"deployment_id": "d1", "service_id": "svc1", "kind": "deploy", "phase": phase,
		"desired": desired, "ready": ready, "message": message,
		"started_at": "2026-10-01T00:00:00Z", "finished_at": nil,
	})
	return fakeReply{200, string(b)}
}

const notFoundBody = `{"type":"about:blank","title":"Not Found","status":404,"swarmy_code":"NOT_FOUND"}`

func newFakeDeployAPI(t *testing.T, replies ...fakeReply) (*fakeDeployAPI, *Client) {
	t.Helper()
	f := &fakeDeployAPI{replies: replies}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.paths = append(f.paths, r.Method+" "+r.URL.Path)
		f.lastAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		path := strings.TrimPrefix(r.URL.Path, "/api/v1")
		switch {
		case strings.HasPrefix(path, "/deployments/"):
			i := f.polls
			if i >= len(f.replies) {
				i = len(f.replies) - 1
			}
			f.polls++
			w.WriteHeader(f.replies[i].status)
			_, _ = w.Write([]byte(f.replies[i].body))
		case strings.HasPrefix(path, "/services/") && f.service != "":
			_, _ = w.Write([]byte(f.service))
		case strings.HasPrefix(path, "/deploys/") && f.events != "":
			_, _ = w.Write([]byte(f.events))
		default:
			w.WriteHeader(404)
			_, _ = w.Write([]byte(notFoundBody))
		}
	}))
	t.Cleanup(srv.Close)
	c, err := New(srv.URL, "swk_test")
	if err != nil {
		t.Fatal(err)
	}
	return f, c
}

var fast = WaitOptions{PollInterval: time.Millisecond, NotFoundGrace: time.Second}

func TestWaitForDeploymentPollsToComplete(t *testing.T) {
	f, c := newFakeDeployAPI(t,
		fakeReply{404, notFoundBody}, // not in the inventory yet
		status("pulling", 0, 2, "pulling image…"),
		status("converging", 1, 2, ""),
		status("complete", 2, 2, ""),
	)
	st, err := c.WaitForDeployment(context.Background(), DeploymentRef{ID: "svc1", DeploymentID: "d1"}, fast)
	if err != nil {
		t.Fatalf("WaitForDeployment: %v", err)
	}
	if st.Phase != PhaseComplete || f.polls != 4 {
		t.Fatalf("phase %q after %d polls, want complete after 4", st.Phase, f.polls)
	}
	if f.paths[0] != "GET /api/v1/deployments/d1" || f.lastAuth != "Bearer swk_test" {
		t.Fatalf("first request %q auth %q", f.paths[0], f.lastAuth)
	}
}

func TestWaitForDeploymentFallsBackToRefID(t *testing.T) {
	// Scale and restart answer deployment_id "": the service id polls instead.
	f, c := newFakeDeployAPI(t, status("complete", 1, 1, ""))
	if _, err := c.WaitForDeployment(context.Background(), DeploymentRef{ID: "svc 1"}, fast); err != nil {
		t.Fatal(err)
	}
	if f.paths[0] != "GET /api/v1/deployments/svc 1" {
		t.Fatalf("polled %q, want the service id", f.paths[0])
	}
	if _, err := c.WaitForDeployment(context.Background(), DeploymentRef{}, fast); err == nil {
		t.Fatal("expected an error with no id to poll")
	}
}

func TestWaitForDeploymentFailedPhaseCarriesTheError(t *testing.T) {
	f, c := newFakeDeployAPI(t,
		status("converging", 0, 1, ""),
		status("failed", 0, 1, "image ghcr.io/acme/nope:1 not found"),
	)
	f.service = `{"id":"svc1","name":"web","image":"x","status":"failed","replicas":{"desired":1,"running":0},"ingress_enabled":false,"node_id":null,"stack_id":null,"updated_at":"","last_error":"No such image: ghcr.io/acme/nope:1"}`
	st, err := c.WaitForDeployment(context.Background(), DeploymentRef{ID: "svc1", DeploymentID: "d1"}, fast)
	var de *DeploymentError
	if !errors.As(err, &de) || de.TimedOut {
		t.Fatalf("err = %#v, want a non-timeout *DeploymentError", err)
	}
	if st == nil || st.Phase != PhaseFailed {
		t.Fatalf("status = %+v", st)
	}
	msg := err.Error()
	for _, want := range []string{"deployment d1 failed", "0/1 ready", "image ghcr.io/acme/nope:1 not found", "service web: No such image"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error %q lacks %q", msg, want)
		}
	}
}

func TestWaitForDeploymentTerminalFailurePhases(t *testing.T) {
	for _, phase := range []string{PhaseRolledBack, PhaseCanceled} {
		_, c := newFakeDeployAPI(t, status(phase, 0, 1, ""))
		_, err := c.WaitForDeployment(context.Background(), DeploymentRef{ID: "svc1", DeploymentID: "d1"}, fast)
		if err == nil || !strings.Contains(err.Error(), "deployment d1 "+phase) {
			t.Fatalf("%s: err = %v", phase, err)
		}
	}
}

func TestWaitForDeploymentTimesOutWithLastStatusAndEvents(t *testing.T) {
	// A stack deployment sums its services: service_id is null.
	stack := status("converging", 1, 3, "")
	stack.body = strings.Replace(stack.body, `"service_id":"svc1"`, `"service_id":null`, 1)
	f, c := newFakeDeployAPI(t, stack)
	f.events = `{"deploy_id":"dep1","stack":"shop","started_at":0,"done":false,"data":[` +
		`{"seq":1,"at":0,"stage":"pull","status":"started","node":"wkr-1","service":"shop_web","message":"pulling web"},` +
		`{"seq":2,"at":0,"stage":"start","status":"failed","node":"wkr-1","service":"shop_web","message":"shop_web: task: non-zero exit (1)"}]}`
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := c.WaitForDeployment(ctx, DeploymentRef{ID: "shop", DeploymentID: "stack:shop", DeployID: "dep1"}, WaitOptions{PollInterval: 5 * time.Millisecond})
	var de *DeploymentError
	if !errors.As(err, &de) || !de.TimedOut {
		t.Fatalf("err = %#v, want a timeout", err)
	}
	msg := err.Error()
	for _, want := range []string{"timed out", "stack:shop", "last phase converging, 1/3 ready", "start on wkr-1: shop_web: task: non-zero exit (1)"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error %q lacks %q", msg, want)
		}
	}
	if strings.Contains(msg, "pulling web") {
		t.Errorf("only failed events belong in the error: %q", msg)
	}
	// A stack deployment has no single service to ask for its last error.
	for _, p := range f.paths {
		if strings.Contains(p, "/services/") {
			t.Errorf("unexpected service read for a stack deployment: %s", p)
		}
	}
}

func TestWaitForDeploymentPersistentNotFound(t *testing.T) {
	_, c := newFakeDeployAPI(t, fakeReply{404, notFoundBody})
	_, err := c.WaitForDeployment(context.Background(), DeploymentRef{ID: "x", DeploymentID: "x"},
		WaitOptions{PollInterval: time.Millisecond, NotFoundGrace: 20 * time.Millisecond})
	var de *DeploymentError
	if !errors.As(err, &de) || de.TimedOut || !IsNotFound(err) {
		t.Fatalf("err = %#v, want a not-found *DeploymentError", err)
	}
	if !strings.Contains(err.Error(), "deployment x not found") {
		t.Fatalf("error %q", err)
	}
}

func TestWaitForDeploymentRetriesTransientErrors(t *testing.T) {
	f, c := newFakeDeployAPI(t,
		fakeReply{503, `{"type":"about:blank","title":"Service Unavailable","status":503}`},
		fakeReply{502, `bad gateway`},
		status("complete", 1, 1, ""),
	)
	if _, err := c.WaitForDeployment(context.Background(), DeploymentRef{DeploymentID: "d1"}, fast); err != nil {
		t.Fatalf("WaitForDeployment: %v", err)
	}
	if f.polls != 3 {
		t.Fatalf("polls = %d, want 3", f.polls)
	}
}

func TestWaitForDeploymentStopsOnClientErrors(t *testing.T) {
	f, c := newFakeDeployAPI(t,
		fakeReply{403, `{"type":"about:blank","title":"Forbidden","status":403,"swarmy_code":"POLICY_DENIED"}`},
		status("complete", 1, 1, ""),
	)
	_, err := c.WaitForDeployment(context.Background(), DeploymentRef{DeploymentID: "d1"}, fast)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != 403 {
		t.Fatalf("err = %#v, want the 403", err)
	}
	if f.polls != 1 {
		t.Fatalf("polls = %d, want 1 (no retry on 4xx)", f.polls)
	}
}
