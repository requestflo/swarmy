package provider

import (
	"context"
	"maps"
	"slices"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

type guardrailsModel struct {
	ID                   types.String `tfsdk:"id"`
	ProductionSafetyMode types.Bool   `tfsdk:"production_safety_mode"`
	Rules                types.Map    `tfsdk:"rules"`
}

type guardrailRuleModel struct {
	Enabled  types.Bool   `tfsdk:"enabled"`
	Severity types.String `tfsdk:"severity"`
	Params   types.Map    `tfsdk:"params"`
	ProdOnly types.Bool   `tfsdk:"prod_only"`
}

var guardrailRuleType = types.ObjectType{AttrTypes: map[string]attr.Type{
	"enabled":   types.BoolType,
	"severity":  types.StringType,
	"params":    types.MapType{ElemType: types.Int64Type},
	"prod_only": types.BoolType,
}}

func managedRules(ctx context.Context, m *guardrailsModel) (map[string]guardrailRuleModel, diag.Diagnostics) {
	rules := map[string]guardrailRuleModel{}
	if m.Rules.IsNull() || m.Rules.IsUnknown() {
		return rules, nil
	}
	return rules, m.Rules.ElementsAs(ctx, &rules, false)
}

// guardrailsBody is the PATCH for the planned switch and managed rules
// (params only when configured: unset keeps the controller's), rules in id
// order so the same configuration always sends the same body.
func guardrailsBody(ctx context.Context, m *guardrailsModel) (client.GuardrailsUpdate, diag.Diagnostics) {
	body := client.GuardrailsUpdate{ProductionSafetyMode: m.ProductionSafetyMode.ValueBool()}
	rules, diags := managedRules(ctx, m)
	for _, id := range slices.Sorted(maps.Keys(rules)) {
		r := rules[id]
		u := client.GuardrailRuleUpdate{ID: id, Enabled: r.Enabled.ValueBool(), Severity: r.Severity.ValueString()}
		if !r.Params.IsNull() && !r.Params.IsUnknown() {
			diags.Append(r.Params.ElementsAs(ctx, &u.Params, false)...)
		}
		body.Rules = append(body.Rules, u)
	}
	return body, diags
}

// guardrailsToState refreshes the switch and every managed rule from g. A
// rule's params keep the keys already tracked (the configured ones), so a
// parameter the configuration never named does not show as drift.
func guardrailsToState(ctx context.Context, g *client.Guardrails, m *guardrailsModel) diag.Diagnostics {
	m.ID = types.StringValue(g.OrgID)
	m.ProductionSafetyMode = types.BoolValue(g.ProductionSafetyMode)
	rules, diags := managedRules(ctx, m)
	if m.Rules.IsNull() || diags.HasError() {
		return diags
	}
	out := map[string]guardrailRuleModel{}
	for id, prior := range rules {
		live := g.Rule(id)
		if live == nil {
			continue // not a rule any more
		}
		params := live.Params
		if !prior.Params.IsNull() && !prior.Params.IsUnknown() {
			tracked := map[string]int64{}
			diags.Append(prior.Params.ElementsAs(ctx, &tracked, false)...)
			params = map[string]int64{}
			for k := range tracked {
				if v, ok := live.Params[k]; ok {
					params[k] = v
				}
			}
		}
		pm, d := types.MapValueFrom(ctx, types.Int64Type, params)
		diags.Append(d...)
		out[id] = guardrailRuleModel{
			Enabled:  types.BoolValue(live.Enabled),
			Severity: types.StringValue(live.Severity),
			Params:   pm,
			ProdOnly: types.BoolValue(live.ProdOnly),
		}
	}
	mv, d := types.MapValueFrom(ctx, guardrailRuleType, out)
	diags.Append(d...)
	m.Rules = mv
	return diags
}
