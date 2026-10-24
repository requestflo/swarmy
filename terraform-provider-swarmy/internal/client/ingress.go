package client

import (
	"context"
	"net/http"
)

// ---- Ingress settings (/ingress/settings) ----
//
// One per org: driver, enabled, topology, controller image, target nodes,
// TLS, the Cloudflare tunnel and the BYO DNS provider. Secrets are
// write-only; the read says whether one is set.

// IngressTLS mirrors the IngressTls DTO.
type IngressTLS struct {
	AcmeEmail *string `json:"acme_email"`
	OnDemand  bool    `json:"on_demand"`
	AskURL    *string `json:"ask_url"`
}

// IngressTunnel mirrors the IngressTunnel DTO (the run token is never returned).
type IngressTunnel struct {
	TunnelID    *string `json:"tunnel_id"`
	TunnelName  string  `json:"tunnel_name"`
	Replicas    int64   `json:"replicas"`
	RunTokenSet bool    `json:"run_token_set"`
}

// IngressDNSProvider mirrors the IngressDnsProvider DTO (the token is never returned).
type IngressDNSProvider struct {
	Provider    string `json:"provider"`
	APITokenSet bool   `json:"api_token_set"`
	SetAt       string `json:"set_at"`
}

// IngressSettings mirrors the IngressSettings DTO (GET/PUT /ingress/settings).
type IngressSettings struct {
	OrgID                  string              `json:"org_id"`
	Driver                 string              `json:"driver"`
	Enabled                bool                `json:"enabled"`
	Topology               string              `json:"topology"`
	ControllerImage        *string             `json:"controller_image"`
	DefaultControllerImage string              `json:"default_controller_image"`
	TargetNodes            []string            `json:"target_nodes"`
	TLS                    IngressTLS          `json:"tls"`
	Tunnel                 *IngressTunnel      `json:"tunnel"`
	DNSProvider            *IngressDNSProvider `json:"dns_provider"`
	UpdatedAt              string              `json:"updated_at"`
}

// IngressSettingsUpdate is the PUT /ingress/settings body. The API merges:
// a key left out keeps its value and a nil value (JSON null) clears a
// nullable field, so the body is a map to say exactly which is meant.
type IngressSettingsUpdate map[string]any

// DefaultIngressSettings is the body that puts every setting back to what a
// new org starts with: swarmy's Caddy, enabled, the replicated controller,
// the default image, no pin, no ACME email, no on-demand TLS, no tunnel and
// no DNS provider.
func DefaultIngressSettings() IngressSettingsUpdate {
	return IngressSettingsUpdate{
		"driver":           "caddy",
		"enabled":          true,
		"topology":         "controller",
		"controller_image": nil,
		"target_nodes":     []string{},
		"tls":              map[string]any{"acme_email": nil, "on_demand": false, "ask_url": nil},
		"tunnel":           nil,
		"dns_provider":     nil,
	}
}

// GetIngressSettings reads the org's ingress settings.
func (c *Client) GetIngressSettings(ctx context.Context) (*IngressSettings, error) {
	var out IngressSettings
	if err := c.get(ctx, "/ingress/settings", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// PutIngressSettings changes the org's ingress settings in one write (admins
// and owners; the edge converges once) and returns them as they now are.
func (c *Client) PutIngressSettings(ctx context.Context, body IngressSettingsUpdate) (*IngressSettings, error) {
	var out IngressSettings
	if err := c.do(ctx, http.MethodPut, "/ingress/settings", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
