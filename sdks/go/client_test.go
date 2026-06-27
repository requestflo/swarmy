package swarmy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

type capturedRequest struct {
	method string
	path   string
	rawQ   string
	auth   string
	accept string
	ctype  string
	body   string
}

// testServer spins up an httptest server that records the request and replies
// with the given status + JSON body.
func testServer(t *testing.T, status int, respBody string, captured *capturedRequest) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		*captured = capturedRequest{
			method: r.Method,
			path:   r.URL.EscapedPath(),
			rawQ:   r.URL.RawQuery,
			auth:   r.Header.Get("Authorization"),
			accept: r.Header.Get("Accept"),
			ctype:  r.Header.Get("Content-Type"),
			body:   string(b),
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, respBody)
	}))
}

func newTestClient(t *testing.T, srv *httptest.Server) *Client {
	t.Helper()
	c, err := NewClient(srv.URL, "swk_test")
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return c
}

func TestListBuildsURLAndAuthHeader(t *testing.T) {
	var cap capturedRequest
	srv := testServer(t, 200, `{"data":[],"next_cursor":null}`, &cap)
	defer srv.Close()
	c := newTestClient(t, srv)

	if _, err := c.Services.List(context.Background(), "", 0); err != nil {
		t.Fatalf("List: %v", err)
	}
	if cap.path != "/api/v1/services" {
		t.Errorf("path = %q, want /api/v1/services", cap.path)
	}
	if cap.method != "GET" {
		t.Errorf("method = %q", cap.method)
	}
	if cap.auth != "Bearer swk_test" {
		t.Errorf("auth = %q", cap.auth)
	}
	if cap.accept == "" {
		t.Errorf("missing Accept header")
	}
}

func TestNoDoubleAPIPrefix(t *testing.T) {
	c, err := NewClient("https://swarm.example.com/api/v1/", "swk_x")
	if err != nil {
		t.Fatal(err)
	}
	if c.baseURL != "https://swarm.example.com/api/v1" {
		t.Errorf("baseURL = %q", c.baseURL)
	}
}

func TestScalePostEncodesIDAndBody(t *testing.T) {
	var cap capturedRequest
	srv := testServer(t, 202, `{"id":"s1","deployment_id":"d1"}`, &cap)
	defer srv.Close()
	c := newTestClient(t, srv)

	ref, err := c.Services.Scale(context.Background(), "svc/with space", 3)
	if err != nil {
		t.Fatalf("Scale: %v", err)
	}
	if cap.path != "/api/v1/services/svc%2Fwith%20space/scale" {
		t.Errorf("path = %q", cap.path)
	}
	if cap.method != "POST" {
		t.Errorf("method = %q", cap.method)
	}
	if cap.ctype != "application/json" {
		t.Errorf("content-type = %q", cap.ctype)
	}
	var body map[string]int
	if err := json.Unmarshal([]byte(cap.body), &body); err != nil {
		t.Fatalf("body unmarshal: %v", err)
	}
	if body["replicas"] != 3 {
		t.Errorf("replicas = %d", body["replicas"])
	}
	if ref.DeploymentID != "d1" {
		t.Errorf("deployment_id = %q", ref.DeploymentID)
	}
}

func TestListQueryParams(t *testing.T) {
	var cap capturedRequest
	srv := testServer(t, 200, `{"data":[],"next_cursor":null}`, &cap)
	defer srv.Close()
	c := newTestClient(t, srv)

	if _, err := c.Stacks.List(context.Background(), "abc", 50); err != nil {
		t.Fatal(err)
	}
	if cap.rawQ != "cursor=abc&limit=50" {
		t.Errorf("query = %q", cap.rawQ)
	}
}

func TestProblemJSONMapsToAPIError(t *testing.T) {
	var cap capturedRequest
	problem := `{"type":"https://swarmy.dev/errors/not-found","title":"Not Found","status":404,"detail":"no such service","swarmy_code":"service_not_found"}`
	srv := testServer(t, 404, problem, &cap)
	defer srv.Close()
	c := newTestClient(t, srv)

	_, err := c.Services.Get(context.Background(), "missing")
	if err == nil {
		t.Fatal("expected error")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error is not *APIError: %T", err)
	}
	if apiErr.Status != 404 {
		t.Errorf("status = %d", apiErr.Status)
	}
	if apiErr.Code() != "service_not_found" {
		t.Errorf("code = %q", apiErr.Code())
	}
	if apiErr.Error() != "no such service" {
		t.Errorf("message = %q", apiErr.Error())
	}
}

func TestIterateFollowsNextCursor(t *testing.T) {
	call := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call++
		w.Header().Set("Content-Type", "application/json")
		if call == 1 {
			_, _ = io.WriteString(w, `{"data":[{"id":"a"},{"id":"b"}],"next_cursor":"p2"}`)
			return
		}
		_, _ = io.WriteString(w, `{"data":[{"id":"c"}],"next_cursor":null}`)
	}))
	defer srv.Close()
	c := newTestClient(t, srv)

	var ids []string
	err := c.Services.Iterate(context.Background(), 0, func(s Service) error {
		ids = append(ids, s.ID)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 3 || ids[0] != "a" || ids[2] != "c" {
		t.Errorf("ids = %v", ids)
	}
}

func TestNewClientValidation(t *testing.T) {
	if _, err := NewClient("", "swk_x"); err == nil {
		t.Error("expected error for empty endpoint")
	}
	if _, err := NewClient("http://x", ""); err == nil {
		t.Error("expected error for empty apiKey")
	}
}
