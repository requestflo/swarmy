package swarmyrum

import (
	"bytes"
	"compress/gzip"
	"context"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
)

var update = flag.Bool("update", false, "rewrite testdata goldens")

const page = `<!doctype html><html><HEAD><title>Demo</title></HEAD><body><h1>hi</h1></body></html>`

func gz(s string) []byte {
	var b bytes.Buffer
	zw := gzip.NewWriter(&b)
	_, _ = zw.Write([]byte(s))
	_ = zw.Close()
	return b.Bytes()
}

type upstream struct {
	headers map[string][]string
	status  int
	chunks  [][]byte
	sawAE   string
}

func (u *upstream) ServeHTTP(w http.ResponseWriter, r *http.Request) error {
	u.sawAE = r.Header.Get("Accept-Encoding")
	for k, vs := range u.headers {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	st := u.status
	if st == 0 {
		st = 200
	}
	w.WriteHeader(st)
	for _, c := range u.chunks {
		_, _ = w.Write(c)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
	return nil
}

type tcase struct {
	name    string
	h       Handler
	req     func(r *http.Request)
	up      upstream
	wantAE  string // what the upstream must see
}

func htmlUp(extra map[string][]string, chunks ...string) upstream {
	h := map[string][]string{"Content-Type": {"text/html; charset=utf-8"}}
	for k, v := range extra {
		h[k] = v
	}
	u := upstream{headers: h}
	for _, c := range chunks {
		u.chunks = append(u.chunks, []byte(c))
	}
	return u
}

func baseHandler() Handler {
	h := Handler{Attrs: map[string]string{
		"data-app":  "tok.abc",
		"data-mode": "analytics",
		"data-uid":  "{http.request.header.X-Swarmy-User}",
	}}
	_ = h.Provision(caddy.Context{})
	return h
}

func cases() []tcase {
	hb := baseHandler()
	skipCSP := baseHandler()
	skipCSP.CSP = "skip"
	small := baseHandler()
	small.MaxScan = 64
	small.MaxSize = 100
	return []tcase{
		{name: "plain", h: hb, up: htmlUp(nil, page), wantAE: "identity"},
		{name: "plain-gzip-client", h: hb, req: func(r *http.Request) { r.Header.Set("Accept-Encoding", "gzip, br") }, up: htmlUp(nil, page), wantAE: "identity"},
		{name: "upstream-gzip", h: hb, req: func(r *http.Request) { r.Header.Set("Accept-Encoding", "gzip") },
			up: upstream{headers: map[string][]string{"Content-Type": {"text/html"}, "Content-Encoding": {"gzip"}}, chunks: [][]byte{gz(page)}}, wantAE: "identity"},
		{name: "upstream-br", h: hb, up: htmlUp(map[string][]string{"Content-Encoding": {"br"}}, "\x0b\x02binary"), wantAE: "identity"},
		{name: "chunked-split-head", h: hb, up: htmlUp(nil, "<html><head><title>x</title></he", "ad><body>streamed</body></html>"), wantAE: "identity"},
		{name: "user-id-escaped", h: hb, req: func(r *http.Request) { r.Header.Set("X-Swarmy-User", `u1"><script>alert(1)</script>`) }, up: htmlUp(nil, page), wantAE: "identity"},
		{name: "non-html-json", h: hb, up: upstream{headers: map[string][]string{"Content-Type": {"application/json"}}, chunks: [][]byte{[]byte(`{"a":1}`)}}, wantAE: "identity"},
		{name: "non-document-request", h: hb, req: func(r *http.Request) {
			r.Header.Set("Accept", "*/*")
			r.Header.Set("Sec-Fetch-Dest", "script")
			r.Header.Set("Accept-Encoding", "gzip")
		}, up: htmlUp(nil, page), wantAE: "gzip"},
		{name: "head-method", h: hb, req: func(r *http.Request) { r.Method = http.MethodHead }, up: htmlUp(nil), wantAE: ""},
		{name: "status-404", h: hb, up: func() upstream { u := htmlUp(nil, page); u.status = 404; return u }(), wantAE: "identity"},
		{name: "no-transform", h: hb, up: htmlUp(map[string][]string{"Cache-Control": {"no-transform"}}, page), wantAE: "identity"},
		{name: "too-large-content-length", h: small, up: htmlUp(map[string][]string{"Content-Length": {"500"}}, strings.Repeat("a", 500)), wantAE: "identity"},
		{name: "no-head-in-window", h: small, up: htmlUp(nil, "<html><body>"+strings.Repeat("x", 100)+"</body></html>"), wantAE: "identity"},
		{name: "csp-self", h: hb, up: htmlUp(map[string][]string{"Content-Security-Policy": {"default-src 'self'; img-src *"}}, page), wantAE: "identity"},
		{name: "csp-host-list-unsafe-inline", h: hb, up: htmlUp(map[string][]string{"Content-Security-Policy": {"script-src https://cdn.example.com 'unsafe-inline'; connect-src https://api.example.com"}}, page), wantAE: "identity"},
		{name: "csp-nonce-reused", h: hb, up: htmlUp(map[string][]string{"Content-Security-Policy": {"script-src 'nonce-appNonce123' 'strict-dynamic'; object-src 'none'"}}, page), wantAE: "identity"},
		{name: "csp-strict-dynamic-hash", h: hb, up: htmlUp(map[string][]string{"Content-Security-Policy": {"script-src 'sha256-abc=' 'strict-dynamic'"}}, page), wantAE: "identity"},
		{name: "csp-default-src-only-cdn", h: hb, up: htmlUp(map[string][]string{"Content-Security-Policy": {"default-src https://cdn.example.com"}}, page), wantAE: "identity"},
		{name: "csp-script-none", h: hb, up: htmlUp(map[string][]string{"Content-Security-Policy": {"script-src 'none'"}}, page), wantAE: "identity"},
		{name: "csp-connect-none", h: hb, up: htmlUp(map[string][]string{"Content-Security-Policy": {"default-src 'self'; connect-src 'none'"}}, page), wantAE: "identity"},
		{name: "csp-two-policies", h: hb, up: htmlUp(map[string][]string{"Content-Security-Policy": {"script-src 'self'", "script-src 'nonce-n1'"}}, page), wantAE: "identity"},
		{name: "csp-mode-skip", h: skipCSP, up: htmlUp(map[string][]string{"Content-Security-Policy": {"default-src 'self'"}}, page), wantAE: "identity"},
		{name: "csp-meta", h: hb, up: htmlUp(nil, `<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'none'"></head></html>`), wantAE: "identity"},
		{name: "etag-weakened", h: hb, up: htmlUp(map[string][]string{"Etag": {`"v1"`}, "Content-Length": {fmt.Sprint(len(page))}}, page), wantAE: "identity"},
	}
}

func render(t *testing.T, c tcase) string {
	t.Helper()
	newNonce = func() string { return "TESTNONCE" }
	req := httptest.NewRequest(http.MethodGet, "http://app.example.com/", nil)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	if c.req != nil {
		c.req(req)
	}
	repl := caddy.NewReplacer()
	repl.Set("http.request.header.X-Swarmy-User", req.Header.Get("X-Swarmy-User"))
	ctx := context.WithValue(req.Context(), caddy.ReplacerCtxKey, repl)
	req = req.WithContext(ctx)
	rec := httptest.NewRecorder()
	up := c.up
	if err := c.h.ServeHTTP(rec, req, &up); err != nil {
		t.Fatal(err)
	}
	if up.sawAE != c.wantAE {
		t.Errorf("upstream Accept-Encoding = %q, want %q", up.sawAE, c.wantAE)
	}
	res := rec.Result()
	body, _ := io.ReadAll(res.Body)
	if res.Header.Get("Content-Encoding") == "gzip" {
		zr, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			t.Fatalf("output claims gzip but is not: %v", err)
		}
		body, _ = io.ReadAll(zr)
		body = append([]byte("[gunzipped] "), body...)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "status: %d\n", res.StatusCode)
	keys := make([]string, 0, len(res.Header))
	for k := range res.Header {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		for _, v := range res.Header[k] {
			fmt.Fprintf(&b, "%s: %s\n", k, v)
		}
	}
	b.WriteString("\n")
	b.Write(body)
	b.WriteString("\n")
	return b.String()
}

func TestInjectGoldens(t *testing.T) {
	for _, c := range cases() {
		t.Run(c.name, func(t *testing.T) {
			got := render(t, c)
			path := filepath.Join("testdata", c.name+".golden")
			if *update {
				_ = os.MkdirAll("testdata", 0o755)
				if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("missing golden (run go test -update): %v", err)
			}
			if got != string(want) {
				t.Errorf("golden mismatch for %s\n--- got ---\n%s\n--- want ---\n%s", c.name, got, want)
			}
		})
	}
}

func TestServerTiming(t *testing.T) {
	h := baseHandler()
	h.ServerTiming = true
	req := httptest.NewRequest(http.MethodGet, "http://app.example.com/api", nil)
	vars := map[string]any{"trace_id": "0af7651916cd43dd8448eb211c80319c", "span_id": "b7ad6b7169203331"}
	ctx := context.WithValue(req.Context(), caddyhttp.VarsCtxKey, vars)
	ctx = context.WithValue(ctx, caddy.ReplacerCtxKey, caddy.NewReplacer())
	rec := httptest.NewRecorder()
	up := upstream{headers: map[string][]string{"Content-Type": {"application/json"}}, chunks: [][]byte{[]byte("{}")}}
	if err := h.ServeHTTP(rec, req.WithContext(ctx), &up); err != nil {
		t.Fatal(err)
	}
	want := `traceparent;desc="00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"`
	if got := rec.Header().Get("Server-Timing"); got != want {
		t.Fatalf("Server-Timing = %q, want %q", got, want)
	}
}

func TestCaddyfileParse(t *testing.T) {
	d := caddyfile.NewTestDispenser(`swarmy_rum {
		script_src /_swarmy/rum.js
		attr data-app tok
		attr data-uid {http.request.header.X-Swarmy-User}
		max_scan 256KiB
		max_size 4MiB
		csp skip
		server_timing
	}`)
	var h Handler
	if err := h.UnmarshalCaddyfile(d); err != nil {
		t.Fatal(err)
	}
	if h.ScriptSrc != "/_swarmy/rum.js" || h.Attrs["data-app"] != "tok" || h.MaxScan != 256<<10 || h.MaxSize != 4<<20 || h.CSP != "skip" || !h.ServerTiming {
		t.Fatalf("parsed %+v", h)
	}
	if err := h.Validate(); err != nil {
		t.Fatal(err)
	}
	bad := Handler{ScriptSrc: "/x.js", CSP: "rewrite", Attrs: map[string]string{"onload": "x"}}
	if bad.Validate() == nil {
		t.Fatal("non data-* attr must be rejected")
	}
	bad2 := Handler{ScriptSrc: "https://evil.example/x.js", CSP: "rewrite"}
	if bad2.Validate() == nil {
		t.Fatal("cross-origin script_src must be rejected")
	}
}

func TestPlanCSPNeverRemovesSources(t *testing.T) {
	in := "default-src 'self' https://a.example; script-src https://cdn.example 'unsafe-inline'; style-src 'self'"
	p := planCSP([]string{in}, "app.example.com", func() string { return "N" })
	if p.Skip != "" || p.Nonce != "" {
		t.Fatalf("unexpected plan %+v", p)
	}
	for _, tok := range strings.Fields(strings.ReplaceAll(in, ";", " ")) {
		if !strings.Contains(p.Policies[0], tok) {
			t.Fatalf("lost token %q in %q", tok, p.Policies[0])
		}
	}
	if strings.Contains(p.Policies[0], "nonce") {
		t.Fatal("a nonce would disable the page's 'unsafe-inline'")
	}
}
