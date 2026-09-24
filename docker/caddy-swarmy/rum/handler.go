// Package swarmyrum is the `http.handlers.swarmy_rum` Caddy module: it adds
// swarmy's real-user-monitoring tag to HTML documents at the edge, so an app
// gets web analytics and (opt-in) session replay WITHOUT any change to the
// app itself.
//
// What it does, per response:
//
//   - Only GET document requests are candidates (Accept: text/html or
//     Sec-Fetch-Dest: document). For those it asks the upstream for an
//     uncompressed body (Accept-Encoding: identity) and remembers whether the
//     client accepts gzip, so the edited page is re-compressed on the way out.
//   - Only a 200 `text/html` response, not `Cache-Control: no-transform`, not a
//     range, not larger than max_size (by Content-Length), is edited. Anything
//     else passes through byte-for-byte.
//   - The first max_scan bytes are held until `</head>` appears; the tag is
//     inserted right before it and the rest streams through unbuffered. A
//     page without `</head>` in that window passes through unchanged.
//   - Enforced Content-Security-Policy headers are rewritten to ADMIT the
//     same-origin tag (a nonce, or 'self'), never loosened beyond that. A
//     policy that forbids scripts or connections outright ('none'), or a
//     <meta http-equiv> policy in the head, skips injection instead.
//   - Every HTML response it looked at carries `Swarmy-Rum: injected` or
//     `Swarmy-Rum: skipped; reason=<why>` so a skip is visible, never silent.
//
// Caddyfile:
//
//	swarmy_rum {
//	    script_src   /_swarmy/rum.js
//	    attr data-app  <signed app token>
//	    attr data-mode analytics
//	    attr data-uid  {http.request.header.X-Swarmy-User}
//	    max_scan     512KiB
//	    max_size     8MiB
//	    csp          rewrite|skip
//	    server_timing
//	}
package swarmyrum

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
)

func init() {
	caddy.RegisterModule(Handler{})
}

// StatusHeader reports what the module did with an HTML response.
const StatusHeader = "Swarmy-Rum"

// Handler injects the RUM script tag into HTML responses.
type Handler struct {
	// ScriptSrc is the tag's src (same-origin, routed to the controller).
	ScriptSrc string `json:"script_src,omitempty"`
	// Attrs are extra tag attributes (names must be data-*); values may carry
	// Caddy placeholders and are HTML-escaped after replacement. Empty values
	// after replacement are dropped.
	Attrs map[string]string `json:"attrs,omitempty"`
	// MaxScan is how far into the body `</head>` is looked for (default 512KiB).
	MaxScan int64 `json:"max_scan,omitempty"`
	// MaxSize skips responses whose Content-Length exceeds it (default 8MiB).
	MaxSize int64 `json:"max_size,omitempty"`
	// CSP is "rewrite" (default: admit the tag) or "skip" (never edit a CSP).
	CSP string `json:"csp,omitempty"`
	// ServerTiming adds `Server-Timing: traceparent;desc=…` from the edge span
	// (the `tracing` handler's trace_id/span_id vars) so the page can link its
	// own navigation to the server trace.
	ServerTiming bool `json:"server_timing,omitempty"`
	// KeepEncoding disables the upstream `Accept-Encoding: identity` rewrite.
	KeepEncoding bool `json:"keep_encoding,omitempty"`
}

// CaddyModule returns the Caddy module information.
func (Handler) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "http.handlers.swarmy_rum",
		New: func() caddy.Module { return new(Handler) },
	}
}

const (
	defaultScriptSrc = "/_swarmy/rum.js"
	defaultMaxScan   = 512 << 10
	defaultMaxSize   = 8 << 20
)

// Provision sets defaults.
func (h *Handler) Provision(caddy.Context) error {
	if h.ScriptSrc == "" {
		h.ScriptSrc = defaultScriptSrc
	}
	if h.MaxScan <= 0 {
		h.MaxScan = defaultMaxScan
	}
	if h.MaxSize <= 0 {
		h.MaxSize = defaultMaxSize
	}
	if h.CSP == "" {
		h.CSP = "rewrite"
	}
	return nil
}

// Validate checks the config.
func (h *Handler) Validate() error {
	if h.CSP != "rewrite" && h.CSP != "skip" {
		return fmt.Errorf("csp must be rewrite or skip, got %q", h.CSP)
	}
	if !strings.HasPrefix(h.ScriptSrc, "/") || strings.ContainsAny(h.ScriptSrc, "\"'<> ") {
		return fmt.Errorf("script_src must be a same-origin absolute path, got %q", h.ScriptSrc)
	}
	for k := range h.Attrs {
		if !validAttrName(k) {
			return fmt.Errorf("attr %q: only data-* attribute names are allowed", k)
		}
	}
	return nil
}

func validAttrName(k string) bool {
	if !strings.HasPrefix(k, "data-") || len(k) <= len("data-") {
		return false
	}
	for _, c := range k {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

func isDocumentRequest(r *http.Request) bool {
	if r.Method != http.MethodGet {
		return false
	}
	if r.Header.Get("Upgrade") != "" || r.Header.Get("Range") != "" {
		return false
	}
	if strings.HasPrefix(r.URL.Path, "/_swarmy/") {
		return false
	}
	if d := r.Header.Get("Sec-Fetch-Dest"); d != "" {
		return d == "document" || d == "iframe"
	}
	return strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/html")
}

func acceptsGzip(ae string) bool {
	for _, part := range strings.Split(ae, ",") {
		f := strings.Split(strings.TrimSpace(part), ";")
		if strings.EqualFold(strings.TrimSpace(f[0]), "gzip") {
			if len(f) > 1 && strings.ReplaceAll(strings.TrimSpace(f[1]), " ", "") == "q=0" {
				return false
			}
			return true
		}
	}
	return false
}

// ServeHTTP implements caddyhttp.MiddlewareHandler.
func (h Handler) ServeHTTP(w http.ResponseWriter, r *http.Request, next caddyhttp.Handler) error {
	if h.ServerTiming {
		if tid, ok := caddyhttp.GetVar(r.Context(), "trace_id").(string); ok && tid != "" {
			sid, _ := caddyhttp.GetVar(r.Context(), "span_id").(string)
			if len(tid) == 32 && len(sid) == 16 {
				w.Header().Add("Server-Timing", fmt.Sprintf(`traceparent;desc="00-%s-%s-01"`, tid, sid))
			}
		}
	}
	if !isDocumentRequest(r) {
		return next.ServeHTTP(w, r)
	}
	clientGzip := acceptsGzip(r.Header.Get("Accept-Encoding"))
	if !h.KeepEncoding {
		r.Header.Set("Accept-Encoding", "identity")
	}
	repl, _ := r.Context().Value(caddy.ReplacerCtxKey).(*caddy.Replacer)
	rw := &injectWriter{
		ResponseWriter: w,
		h:              &h,
		host:           r.Host,
		clientGzip:     clientGzip,
		tag:            func(nonce string) []byte { return h.renderTag(repl, nonce) },
	}
	err := next.ServeHTTP(rw, r)
	if cerr := rw.finish(); err == nil {
		err = cerr
	}
	return err
}

// renderTag builds the script element. Attribute order is sorted so output is
// deterministic (golden-tested).
func (h *Handler) renderTag(repl *caddy.Replacer, nonce string) []byte {
	var b strings.Builder
	b.WriteString(`<script src="`)
	b.WriteString(html.EscapeString(h.ScriptSrc))
	b.WriteString(`" async`)
	keys := make([]string, 0, len(h.Attrs))
	for k := range h.Attrs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		v := h.Attrs[k]
		if repl != nil {
			v = repl.ReplaceAll(v, "")
		}
		if v == "" {
			continue
		}
		b.WriteString(" ")
		b.WriteString(k)
		b.WriteString(`="`)
		b.WriteString(html.EscapeString(v))
		b.WriteString(`"`)
	}
	if nonce != "" {
		b.WriteString(` nonce="`)
		b.WriteString(html.EscapeString(nonce))
		b.WriteString(`"`)
	}
	b.WriteString(`></script>`)
	return []byte(b.String())
}

func randomNonce() string {
	var buf [16]byte
	_, _ = rand.Read(buf[:])
	return base64.StdEncoding.EncodeToString(buf[:])
}

// newNonce is swapped in tests for deterministic goldens.
var newNonce = randomNonce

type writerState int

const (
	stateUndecided writerState = iota // WriteHeader not seen yet
	statePass                         // pass-through, untouched
	stateScan                         // holding the head, looking for </head>
	stateGzipBuffer                   // upstream ignored identity: buffer, gunzip, edit
	stateStream                       // tag placed (or given up): stream the rest
)

type injectWriter struct {
	http.ResponseWriter
	h          *Handler
	host       string
	clientGzip bool
	tag        func(nonce string) []byte

	state   writerState
	status  int
	buf     bytes.Buffer
	plan    cspPlan
	out     io.Writer // body sink once headers are written (maybe a gzip writer)
	gz      *gzip.Writer
	wroteHd bool
}

func (w *injectWriter) skip(reason string) {
	w.ResponseWriter.Header().Set(StatusHeader, "skipped; reason="+reason)
}

// WriteHeader decides whether this response is a candidate.
func (w *injectWriter) WriteHeader(code int) {
	if w.state != stateUndecided {
		return
	}
	// 1xx informational responses (103 Early Hints) pass straight through.
	if code >= 100 && code < 200 {
		w.ResponseWriter.WriteHeader(code)
		return
	}
	w.status = code
	hd := w.ResponseWriter.Header()
	ct := strings.ToLower(hd.Get("Content-Type"))
	isHTML := strings.HasPrefix(ct, "text/html")
	reason := ""
	switch {
	case !isHTML:
		w.pass(code)
		return
	case code != http.StatusOK:
		reason = "status"
	case strings.Contains(strings.ToLower(hd.Get("Cache-Control")), "no-transform"):
		reason = "no-transform"
	case hd.Get("Content-Range") != "":
		reason = "range"
	}
	if reason == "" {
		if cl, err := strconv.ParseInt(hd.Get("Content-Length"), 10, 64); err == nil && cl > w.h.MaxSize {
			reason = "too-large"
		}
	}
	enc := strings.ToLower(strings.TrimSpace(hd.Get("Content-Encoding")))
	if reason == "" && enc != "" && enc != "identity" && enc != "gzip" {
		reason = "encoding-" + enc
	}
	if reason == "" {
		csp := hd.Values("Content-Security-Policy")
		if len(csp) > 0 {
			if w.h.CSP == "skip" {
				reason = "csp"
			} else {
				w.plan = planCSP(csp, w.host, newNonce)
				if w.plan.Skip != "" {
					reason = w.plan.Skip
				}
			}
		}
	}
	if reason != "" {
		w.skip(reason)
		w.pass(code)
		return
	}
	if enc == "gzip" {
		w.state = stateGzipBuffer
		return
	}
	w.state = stateScan
}

func (w *injectWriter) pass(code int) {
	w.state = statePass
	w.wroteHd = true
	w.ResponseWriter.WriteHeader(code)
}

// startEdited writes the final headers for an edited (or given-up) response.
func (w *injectWriter) startEdited(injected bool, skipReason string) {
	hd := w.ResponseWriter.Header()
	hd.Del("Content-Length")
	hd.Del("Content-Encoding")
	// Validators describe the upstream bytes, not ours.
	if injected {
		if et := hd.Get("ETag"); et != "" && !strings.HasPrefix(et, "W/") {
			hd.Set("ETag", "W/"+et)
		}
		if w.plan.Changed {
			hd.Del("Content-Security-Policy")
			for _, p := range w.plan.Policies {
				hd.Add("Content-Security-Policy", p)
			}
		}
		hd.Set(StatusHeader, "injected")
	} else {
		w.skip(skipReason)
	}
	hd.Add("Vary", "Accept-Encoding")
	w.out = w.ResponseWriter
	if w.clientGzip {
		hd.Set("Content-Encoding", "gzip")
		w.gz = gzip.NewWriter(w.ResponseWriter)
		w.out = w.gz
	}
	w.wroteHd = true
	w.ResponseWriter.WriteHeader(w.status)
}

var headClose = []byte("</head")

// scanHead looks at the held prefix: inject before `</head>`, give up on a
// meta CSP or when the window is exhausted. Returns true once decided.
func (w *injectWriter) scanHead(final bool) error {
	data := w.buf.Bytes()
	lower := bytes.ToLower(data)
	idx := bytes.Index(lower, headClose)
	head := lower
	if idx >= 0 {
		head = lower[:idx]
	}
	if bytes.Contains(head, []byte("content-security-policy")) && bytes.Contains(head, []byte("http-equiv")) {
		return w.decide(false, "csp-meta", -1)
	}
	if idx >= 0 {
		return w.decide(true, "", idx)
	}
	if final || int64(len(data)) >= w.h.MaxScan {
		return w.decide(false, "no-head", -1)
	}
	return nil
}

func (w *injectWriter) decide(inject bool, reason string, at int) error {
	w.state = stateStream
	w.startEdited(inject, reason)
	data := w.buf.Bytes()
	w.buf = bytes.Buffer{}
	if !inject {
		_, err := w.out.Write(data)
		return err
	}
	if _, err := w.out.Write(data[:at]); err != nil {
		return err
	}
	if _, err := w.out.Write(w.tag(w.plan.Nonce)); err != nil {
		return err
	}
	_, err := w.out.Write(data[at:])
	return err
}

func (w *injectWriter) Write(p []byte) (int, error) {
	if w.state == stateUndecided {
		w.WriteHeader(http.StatusOK)
	}
	switch w.state {
	case statePass:
		return w.ResponseWriter.Write(p)
	case stateStream:
		return w.out.Write(p)
	case stateGzipBuffer:
		if int64(w.buf.Len()+len(p)) > w.h.MaxSize {
			// Too big to edit: emit what we hold (still gzip) and pass on.
			w.skip("too-large")
			w.state = statePass
			w.wroteHd = true
			w.ResponseWriter.WriteHeader(w.status)
			held := w.buf.Bytes()
			w.buf = bytes.Buffer{}
			if _, err := w.ResponseWriter.Write(held); err != nil {
				return 0, err
			}
			return w.ResponseWriter.Write(p)
		}
		return w.buf.Write(p)
	case stateScan:
		w.buf.Write(p)
		if err := w.scanHead(false); err != nil {
			return 0, err
		}
		return len(p), nil
	}
	return len(p), nil
}

// Flush: while holding the head we keep holding (the tag needs `</head>`);
// once streaming, flushes pass through so streamed HTML stays streamed.
func (w *injectWriter) Flush() {
	if w.state == stateStream || w.state == statePass {
		if w.gz != nil {
			_ = w.gz.Flush()
		}
		if f, ok := w.ResponseWriter.(http.Flusher); ok {
			f.Flush()
		}
	}
}

// finish drains whatever is held once the upstream handler returns.
func (w *injectWriter) finish() error {
	switch w.state {
	case stateUndecided:
		// Handler wrote nothing at all.
		return nil
	case stateScan:
		if err := w.scanHead(true); err != nil {
			return err
		}
	case stateGzipBuffer:
		zr, err := gzip.NewReader(bytes.NewReader(w.buf.Bytes()))
		var plain []byte
		if err == nil {
			plain, err = io.ReadAll(zr)
		}
		if err != nil {
			// Not valid gzip after all: pass the bytes through as they came.
			w.skip("bad-gzip")
			w.state = statePass
			w.wroteHd = true
			w.ResponseWriter.WriteHeader(w.status)
			_, werr := w.ResponseWriter.Write(w.buf.Bytes())
			return werr
		}
		w.buf = *bytes.NewBuffer(plain)
		// The upstream compressed, so the client accepts it: re-compress.
		w.clientGzip = true
		if err := w.scanHead(true); err != nil {
			return err
		}
	}
	if w.gz != nil {
		return w.gz.Close()
	}
	return nil
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (w *injectWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// Hijack passes through for completeness (document requests never upgrade).
func (w *injectWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := w.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, fmt.Errorf("hijack not supported")
}

// Interface guards.
var (
	_ caddy.Provisioner           = (*Handler)(nil)
	_ caddy.Validator             = (*Handler)(nil)
	_ caddyhttp.MiddlewareHandler = (*Handler)(nil)
)
