package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNodeActionRequests(t *testing.T) {
	var got []string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.Method+" "+r.URL.Path)
		if r.Method == http.MethodPut {
			_ = json.NewDecoder(r.Body).Decode(&body)
			_, _ = w.Write([]byte(`{"id":"n1","labels":{"tier":"edge"}}`))
			return
		}
		if r.Method == http.MethodDelete {
			_, _ = w.Write([]byte(`{"id":"n1","removed":true}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"n1","availability":"drain"}`))
	}))
	defer srv.Close()
	c, _ := New(srv.URL, "swk_test")
	ctx := context.Background()

	// A blank value is how a label is cleared: the API merges, never deletes.
	if _, err := c.SetNodeLabels(ctx, "n1", map[string]string{"tier": "edge", "old": ""}); err != nil {
		t.Fatal(err)
	}
	labels, _ := body["labels"].(map[string]any)
	if labels["tier"] != "edge" || labels["old"] != "" {
		t.Fatalf("labels body = %v", body)
	}
	if a, err := c.DrainNode(ctx, "n1"); err != nil || a.Availability != "drain" {
		t.Fatalf("DrainNode = %+v, %v", a, err)
	}
	if _, err := c.UncordonNode(ctx, "n1"); err != nil {
		t.Fatal(err)
	}
	if err := c.RemoveNode(ctx, "n1"); err != nil {
		t.Fatal(err)
	}
	want := []string{"PUT /api/v1/nodes/n1/labels", "POST /api/v1/nodes/n1/drain", "POST /api/v1/nodes/n1/uncordon", "DELETE /api/v1/nodes/n1"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("requests = %v, want %v", got, want)
	}
}
