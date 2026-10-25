package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// fakeAlertsAPI stands in for /alert-rules and /notification-channels with the
// controller's semantics: a PATCH changes only the fields it names, the
// signal never changes, a channel's destination is kept (encrypted, here
// plainly) and never returned, and new channels start enabled.
type fakeAlertsAPI struct {
	mu       sync.Mutex
	seq      int
	rules    map[string]map[string]any
	channels map[string]map[string]any
	dests    map[string]map[string]any // channel id → destination as last written
	calls    []string                  // "METHOD path body"
}

func newFakeAlertsAPI(t *testing.T) (*fakeAlertsAPI, *httptest.Server) {
	t.Helper()
	f := &fakeAlertsAPI{rules: map[string]map[string]any{}, channels: map[string]map[string]any{}, dests: map[string]map[string]any{}}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeAlertsAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	path := strings.TrimPrefix(r.URL.Path, "/api/v1")
	raw, _ := json.Marshal(body)
	if r.Method != http.MethodGet {
		f.calls = append(f.calls, fmt.Sprintf("%s %s %s", r.Method, path, raw))
	}
	w.Header().Set("Content-Type", "application/json")
	reply := func(status int, v any) {
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	}
	notFound := func() { reply(404, map[string]any{"title": "Not Found", "status": 404, "swarmy_code": "NOT_FOUND"}) }
	coll, id, _ := strings.Cut(strings.TrimPrefix(path, "/"), "/")
	id, _ = url.PathUnescape(id)
	rows := map[string]map[string]map[string]any{"alert-rules": f.rules, "notification-channels": f.channels}[coll]
	if rows == nil {
		notFound()
		return
	}
	switch {
	case r.Method == http.MethodPost && id == "":
		f.seq++
		row := map[string]any{"id": fmt.Sprintf("%s-%d", coll[:2], f.seq), "created_at": "2026-10-01T00:00:00.000Z", "name": body["name"]}
		if coll == "alert-rules" {
			row["signal"], row["is_default"], row["muted_until"] = body["signal"], false, nil
			row["selector"], row["threshold"], row["for_seconds"], row["channel_ids"], row["enabled"] = map[string]any{}, nil, 0, []any{}, true
		} else {
			row["enabled"] = true
		}
		rows[row["id"].(string)] = row
		f.apply(coll, row, body)
		reply(201, row)
	case rows[id] == nil:
		notFound()
	case r.Method == http.MethodGet:
		reply(200, rows[id])
	case r.Method == http.MethodPatch:
		f.apply(coll, rows[id], body)
		reply(200, rows[id])
	case r.Method == http.MethodDelete:
		delete(rows, id)
		reply(200, map[string]any{"id": id, "removed": true})
	}
}

// apply writes the named fields; the caller holds f.mu.
func (f *fakeAlertsAPI) apply(coll string, row, body map[string]any) {
	for k, v := range body {
		switch {
		case k == "signal":
		case k == "config":
			cfg := v.(map[string]any)
			f.dests[row["id"].(string)] = cfg
			row["kind"] = cfg["kind"]
			row["has_secret"] = cfg["secret"] != nil || cfg["token"] != nil || cfg["bot_token"] != nil
			row["target"] = cfg["to"]
			if u, ok := cfg["url"].(string); ok {
				parsed, _ := url.Parse(u)
				row["target"] = parsed.Host
			}
		default:
			row[k] = v
		}
	}
}
