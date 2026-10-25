package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

// alertRuleBody is the whole rule as planned: the create and the update send
// every field, so the configuration is the whole truth (an unset threshold is
// sent as null, no target as "any subject").
func alertRuleBody(ctx context.Context, m *alertRuleModel, diags *diag.Diagnostics) client.AlertRuleWrite {
	b := client.AlertRuleWrite{
		Name:       m.Name.ValueString(),
		Signal:     m.Signal.ValueString(),
		Selector:   client.AlertSelector{App: m.App.ValueString(), Server: m.Server.ValueString(), Service: m.Service.ValueString()},
		ForSeconds: m.ForSeconds.ValueInt64(),
		Enabled:    m.Enabled.ValueBool(),
		ChannelIDs: []string{},
	}
	if !m.Threshold.IsNull() && !m.Threshold.IsUnknown() {
		v := m.Threshold.ValueFloat64()
		b.Threshold = &v
	}
	diags.Append(m.ChannelIDs.ElementsAs(ctx, &b.ChannelIDs, false)...)
	return b
}

// alertRuleToState copies the rule as the API answers it (every argument is
// returned, so a change made in the dashboard shows as drift).
func alertRuleToState(ctx context.Context, rule *client.AlertRule, m *alertRuleModel) diag.Diagnostics {
	m.ID = types.StringValue(rule.ID)
	m.Name = types.StringValue(rule.Name)
	m.Signal = types.StringValue(rule.Signal)
	m.App = optionalString(rule.Selector.App)
	m.Server = optionalString(rule.Selector.Server)
	m.Service = optionalString(rule.Selector.Service)
	m.Threshold = types.Float64PointerValue(rule.Threshold)
	m.ForSeconds = types.Int64Value(rule.ForSeconds)
	m.Enabled = types.BoolValue(rule.Enabled)
	m.IsDefault = types.BoolValue(rule.IsDefault)
	m.MutedUntil = stringPtrToValue(rule.MutedUntil)
	m.CreatedAt = types.StringValue(rule.CreatedAt)
	ids := rule.ChannelIDs
	if ids == nil {
		ids = []string{}
	}
	set, diags := types.SetValueFrom(ctx, types.StringType, ids)
	m.ChannelIDs = set
	return diags
}

// optionalString is null for "", the API's "not set" for an optional name.
func optionalString(s string) types.String {
	if s == "" {
		return types.StringNull()
	}
	return types.StringValue(s)
}
