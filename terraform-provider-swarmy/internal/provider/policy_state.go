package provider

import (
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

type policyModel struct {
	ID          types.String `tfsdk:"id"`
	Name        types.String `tfsdk:"name"`
	Description types.String `tfsdk:"description"`
	Effect      types.String `tfsdk:"effect"`
	Source      types.String `tfsdk:"source"`
	Priority    types.Int64  `tfsdk:"priority"`
	Enabled     types.Bool   `tfsdk:"enabled"`
	IsDefault   types.Bool   `tfsdk:"is_default"`
	Sentence    types.String `tfsdk:"sentence"`
	UpdatedAt   types.String `tfsdk:"updated_at"`
}

func policyBody(m *policyModel) client.PolicyWrite {
	return client.PolicyWrite{
		Name: m.Name.ValueString(), Description: valueToStringPtr(m.Description), Effect: m.Effect.ValueString(),
		Source: m.Source.ValueString(), Priority: m.Priority.ValueInt64(), Enabled: m.Enabled.ValueBool(),
	}
}

func policyToState(p *client.Policy, m *policyModel) {
	m.ID, m.Name, m.Description = types.StringValue(p.ID), types.StringValue(p.Name), stringPtrToValue(p.Description)
	m.Effect, m.Source, m.Priority = types.StringValue(p.Effect), types.StringValue(p.Source), types.Int64Value(p.Priority)
	m.Enabled, m.IsDefault = types.BoolValue(p.Enabled), types.BoolValue(p.IsDefault)
	m.Sentence, m.UpdatedAt = types.StringValue(p.Sentence), types.StringValue(p.UpdatedAt)
}
