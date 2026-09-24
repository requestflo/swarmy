// Package swarmydns is the `dns.providers.swarmy` Caddy module: ACME DNS-01
// through swarmy's OWN authoritative nameservers (swarmy-dns), so wildcard
// certificates need no third-party DNS API.
//
// The edge never talks to a nameserver directly. It POSTs the challenge to
// the swarmy controller, which checks the name belongs to the org, stages the
// TXT record in the zone snapshot and pushes it to every swarmy-dns node
// before answering — so whichever nameserver the CA asks already has it.
//
//	POST {endpoint}/present  {"fqdn":"_acme-challenge.acme.com.","value":"<digest>"}
//	POST {endpoint}/cleanup  {"fqdn":"_acme-challenge.acme.com.","value":"<digest>"}
//	Authorization: Bearer <contents of token_file>
//
// The token is read from a file (a Docker secret) at each call — it never
// enters the Caddyfile, the adapted JSON or Caddy's autosave.
//
// Caddyfile:
//
//	tls {
//	    dns swarmy {
//	        endpoint   http://swarmy_controller:3021/ingress/acme-dns/<orgId>
//	        token_file /run/secrets/swarmy-acme-dns
//	    }
//	}
package swarmydns

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
	"github.com/libdns/libdns"
)

func init() {
	caddy.RegisterModule(Provider{})
}

// Provider solves DNS-01 by asking the swarmy controller to publish the TXT.
type Provider struct {
	// Endpoint is the controller's per-org challenge API base URL.
	Endpoint string `json:"endpoint,omitempty"`
	// TokenFile holds the bearer token (a Docker secret mount).
	TokenFile string `json:"token_file,omitempty"`

	client *http.Client
}

// CaddyModule returns the Caddy module information.
func (Provider) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "dns.providers.swarmy",
		New: func() caddy.Module { return new(Provider) },
	}
}

// Provision validates the configuration.
func (p *Provider) Provision(ctx caddy.Context) error {
	repl := caddy.NewReplacer()
	p.Endpoint = strings.TrimRight(repl.ReplaceAll(p.Endpoint, ""), "/")
	p.TokenFile = repl.ReplaceAll(p.TokenFile, "")
	if p.Endpoint == "" {
		return fmt.Errorf("swarmy dns: endpoint is required")
	}
	if p.TokenFile == "" {
		return fmt.Errorf("swarmy dns: token_file is required")
	}
	return nil
}

// UnmarshalCaddyfile sets up the provider from Caddyfile tokens:
//
//	swarmy {
//	    endpoint <url>
//	    token_file <path>
//	}
func (p *Provider) UnmarshalCaddyfile(d *caddyfile.Dispenser) error {
	for d.Next() {
		if d.NextArg() {
			return d.ArgErr()
		}
		for nesting := d.Nesting(); d.NextBlock(nesting); {
			switch d.Val() {
			case "endpoint":
				if !d.NextArg() {
					return d.ArgErr()
				}
				p.Endpoint = d.Val()
			case "token_file":
				if !d.NextArg() {
					return d.ArgErr()
				}
				p.TokenFile = d.Val()
			default:
				return d.Errf("unrecognized subdirective '%s'", d.Val())
			}
			if d.NextArg() {
				return d.ArgErr()
			}
		}
	}
	return nil
}

type challenge struct {
	FQDN  string `json:"fqdn"`
	Value string `json:"value"`
}

func (p *Provider) httpClient() *http.Client {
	if p.client == nil {
		// The controller pushes to every nameserver before it answers.
		p.client = &http.Client{Timeout: 90 * time.Second}
	}
	return p.client
}

func (p *Provider) token() (string, error) {
	raw, err := os.ReadFile(p.TokenFile)
	if err != nil {
		return "", fmt.Errorf("swarmy dns: reading token_file: %w", err)
	}
	t := strings.TrimSpace(string(raw))
	if t == "" {
		return "", fmt.Errorf("swarmy dns: token_file %s is empty", p.TokenFile)
	}
	return t, nil
}

func (p *Provider) call(ctx context.Context, action string, c challenge) error {
	token, err := p.token()
	if err != nil {
		return err
	}
	body, _ := json.Marshal(c)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.Endpoint+"/"+action, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := p.httpClient().Do(req)
	if err != nil {
		return fmt.Errorf("swarmy dns: %s %s: %w", action, c.FQDN, err)
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		msg, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("swarmy dns: %s %s: HTTP %d: %s", action, c.FQDN, res.StatusCode, strings.TrimSpace(string(msg)))
	}
	return nil
}

func (p *Provider) each(ctx context.Context, action, zone string, recs []libdns.Record) ([]libdns.Record, error) {
	var done []libdns.Record
	for _, rec := range recs {
		rr := rec.RR()
		if rr.Type != "TXT" {
			return done, fmt.Errorf("swarmy dns: only TXT records are supported (got %s)", rr.Type)
		}
		fqdn := libdns.AbsoluteName(rr.Name, zone)
		if err := p.call(ctx, action, challenge{FQDN: fqdn, Value: rr.Data}); err != nil {
			return done, err
		}
		done = append(done, rec)
	}
	return done, nil
}

// AppendRecords publishes the challenge TXT records.
func (p *Provider) AppendRecords(ctx context.Context, zone string, recs []libdns.Record) ([]libdns.Record, error) {
	return p.each(ctx, "present", zone, recs)
}

// DeleteRecords withdraws the challenge TXT records.
func (p *Provider) DeleteRecords(ctx context.Context, zone string, recs []libdns.Record) ([]libdns.Record, error) {
	return p.each(ctx, "cleanup", zone, recs)
}

// Interface guards.
var (
	_ caddy.Provisioner     = (*Provider)(nil)
	_ caddyfile.Unmarshaler = (*Provider)(nil)
	_ libdns.RecordAppender = (*Provider)(nil)
	_ libdns.RecordDeleter  = (*Provider)(nil)
)
