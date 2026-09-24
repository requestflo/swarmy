package swarmydns

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
	"github.com/libdns/libdns"
)

func TestPresentAndCleanup(t *testing.T) {
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer s3cret" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		var c challenge
		_ = json.NewDecoder(r.Body).Decode(&c)
		got = append(got, r.URL.Path+" "+c.FQDN+" "+c.Value)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	tok := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tok, []byte("s3cret\n"), 0o400); err != nil {
		t.Fatal(err)
	}
	p := &Provider{Endpoint: srv.URL + "/ingress/acme-dns/org_1/", TokenFile: tok}
	p.Endpoint = p.Endpoint[:len(p.Endpoint)-1]
	recs := []libdns.Record{libdns.TXT{Name: "_acme-challenge", Text: "digest-1"}}
	if _, err := p.AppendRecords(context.Background(), "acme.com.", recs); err != nil {
		t.Fatal(err)
	}
	if _, err := p.DeleteRecords(context.Background(), "acme.com.", recs); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"/ingress/acme-dns/org_1/present _acme-challenge.acme.com. digest-1",
		"/ingress/acme-dns/org_1/cleanup _acme-challenge.acme.com. digest-1",
	}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("calls = %q, want %q", got, want)
	}
}

func TestRefusalSurfaces(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "evil.acme.com is not routed by this org", http.StatusForbidden)
	}))
	defer srv.Close()
	tok := filepath.Join(t.TempDir(), "token")
	_ = os.WriteFile(tok, []byte("x"), 0o400)
	p := &Provider{Endpoint: srv.URL, TokenFile: tok}
	_, err := p.AppendRecords(context.Background(), "acme.com.", []libdns.Record{libdns.TXT{Name: "_acme-challenge.evil", Text: "d"}})
	if err == nil || !strings.Contains(err.Error(), "HTTP 403") {
		t.Fatalf("err = %v", err)
	}
	if _, err := p.AppendRecords(context.Background(), "acme.com.", []libdns.Record{libdns.Address{Name: "x"}}); err == nil {
		t.Fatal("non-TXT must be refused")
	}
}

func TestMissingTokenFile(t *testing.T) {
	p := &Provider{Endpoint: "http://127.0.0.1:1", TokenFile: "/nonexistent"}
	if _, err := p.AppendRecords(context.Background(), "a.", []libdns.Record{libdns.TXT{Name: "_acme-challenge", Text: "d"}}); err == nil {
		t.Fatal("expected error")
	}
}

func TestUnmarshalCaddyfile(t *testing.T) {
	d := caddyfile.NewTestDispenser(`swarmy {
		endpoint http://swarmy_controller:3021/ingress/acme-dns/org_1
		token_file /run/secrets/swarmy-acme-dns
	}`)
	var p Provider
	if err := p.UnmarshalCaddyfile(d); err != nil {
		t.Fatal(err)
	}
	if p.Endpoint != "http://swarmy_controller:3021/ingress/acme-dns/org_1" || p.TokenFile != "/run/secrets/swarmy-acme-dns" {
		t.Fatalf("%+v", p)
	}
	bad := caddyfile.NewTestDispenser(`swarmy { token s3cret }`)
	if err := new(Provider).UnmarshalCaddyfile(bad); err == nil {
		t.Fatal("inline tokens must be rejected")
	}
}
