package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

// ingressModel is the Terraform state model for swarmy_ingress.
type ingressModel struct {
	ID                     types.String        `tfsdk:"id"`
	Driver                 types.String        `tfsdk:"driver"`
	Enabled                types.Bool          `tfsdk:"enabled"`
	Topology               types.String        `tfsdk:"topology"`
	ControllerImage        types.String        `tfsdk:"controller_image"`
	DefaultControllerImage types.String        `tfsdk:"default_controller_image"`
	TargetNodes            types.List          `tfsdk:"target_nodes"`
	AcmeEmail              types.String        `tfsdk:"acme_email"`
	OnDemandTLS            types.Bool          `tfsdk:"on_demand_tls"`
	OnDemandAskURL         types.String        `tfsdk:"on_demand_ask_url"`
	Tunnel                 *ingressTunnelModel `tfsdk:"tunnel"`
	DNSProvider            *ingressDNSModel    `tfsdk:"dns_provider"`
}

type ingressTunnelModel struct {
	RunToken types.String `tfsdk:"run_token"`
	Name     types.String `tfsdk:"name"`
	Replicas types.Int64  `tfsdk:"replicas"`
}

type ingressDNSModel struct {
	Provider types.String `tfsdk:"provider"`
	APIToken types.String `tfsdk:"api_token"`
}

// ingressBody is the PUT body for the planned settings. Every non-secret
// setting is sent (the configuration is the whole truth: unset means the
// default); the tunnel and DNS provider, which carry write-only tokens, only
// when withSecrets (create, or they changed).
func ingressBody(ctx context.Context, m *ingressModel, withSecrets bool) (client.IngressSettingsUpdate, diag.Diagnostics) {
	nodes := []string{}
	diags := m.TargetNodes.ElementsAs(ctx, &nodes, false)
	body := client.IngressSettingsUpdate{
		"driver":           m.Driver.ValueString(),
		"enabled":          m.Enabled.ValueBool(),
		"topology":         m.Topology.ValueString(),
		"controller_image": valueToStringPtr(m.ControllerImage),
		"target_nodes":     nodes,
		"tls": map[string]any{
			"acme_email": valueToStringPtr(m.AcmeEmail),
			"on_demand":  m.OnDemandTLS.ValueBool(),
			"ask_url":    valueToStringPtr(m.OnDemandAskURL),
		},
	}
	if withSecrets {
		body["tunnel"] = nil
		if t := m.Tunnel; t != nil {
			body["tunnel"] = map[string]any{"run_token": t.RunToken.ValueString(), "tunnel_name": t.Name.ValueString(), "replicas": t.Replicas.ValueInt64()}
		}
		body["dns_provider"] = nil
		if d := m.DNSProvider; d != nil {
			body["dns_provider"] = map[string]any{"provider": d.Provider.ValueString(), "api_token": d.APIToken.ValueString()}
		}
	}
	return body, diags
}

// secretsChanged reports whether the tunnel or DNS provider differ between
// plan and state (tokens included), i.e. whether they must be sent.
func secretsChanged(plan, state *ingressModel) bool {
	tunnel := (plan.Tunnel == nil) != (state.Tunnel == nil) ||
		(plan.Tunnel != nil && (!plan.Tunnel.RunToken.Equal(state.Tunnel.RunToken) || !plan.Tunnel.Name.Equal(state.Tunnel.Name) ||
			!plan.Tunnel.Replicas.Equal(state.Tunnel.Replicas)))
	dns := (plan.DNSProvider == nil) != (state.DNSProvider == nil) ||
		(plan.DNSProvider != nil && (!plan.DNSProvider.Provider.Equal(state.DNSProvider.Provider) ||
			!plan.DNSProvider.APIToken.Equal(state.DNSProvider.APIToken)))
	return tunnel || dns
}

// mapIngressToState copies the API settings onto m. Tokens are never
// returned, so they are kept from m (prior plan/state) while the API says
// one is set, and dropped when it says none is (so the next plan re-sends it).
func mapIngressToState(ctx context.Context, s *client.IngressSettings, m *ingressModel) diag.Diagnostics {
	m.ID = types.StringValue(s.OrgID)
	m.Driver = types.StringValue(s.Driver)
	m.Enabled = types.BoolValue(s.Enabled)
	m.Topology = types.StringValue(s.Topology)
	m.ControllerImage = stringPtrToValue(s.ControllerImage)
	m.DefaultControllerImage = types.StringValue(s.DefaultControllerImage)
	nodes := s.TargetNodes
	if nodes == nil {
		nodes = []string{}
	}
	list, diags := stringsToList(ctx, nodes)
	m.TargetNodes = list
	m.AcmeEmail = stringPtrToValue(s.TLS.AcmeEmail)
	m.OnDemandTLS = types.BoolValue(s.TLS.OnDemand)
	m.OnDemandAskURL = stringPtrToValue(s.TLS.AskURL)

	if s.Tunnel == nil {
		m.Tunnel = nil
	} else {
		token := types.StringNull()
		if m.Tunnel != nil && s.Tunnel.RunTokenSet {
			token = m.Tunnel.RunToken
		}
		m.Tunnel = &ingressTunnelModel{RunToken: token, Name: types.StringValue(s.Tunnel.TunnelName), Replicas: types.Int64Value(s.Tunnel.Replicas)}
	}
	if s.DNSProvider == nil {
		m.DNSProvider = nil
	} else {
		token := types.StringNull()
		if m.DNSProvider != nil && s.DNSProvider.APITokenSet && m.DNSProvider.Provider.ValueString() == s.DNSProvider.Provider {
			token = m.DNSProvider.APIToken
		}
		m.DNSProvider = &ingressDNSModel{Provider: types.StringValue(s.DNSProvider.Provider), APIToken: token}
	}
	return diags
}
