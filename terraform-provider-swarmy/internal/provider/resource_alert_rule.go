package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setdefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

var (
	_ resource.ResourceWithConfigure   = (*alertRuleResource)(nil)
	_ resource.ResourceWithImportState = (*alertRuleResource)(nil)
)

// alertRuleResource manages swarmy_alert_rule over /alert-rules. Every
// argument but `signal` updates in place (one PATCH carrying the whole rule).
type alertRuleResource struct{ client *client.Client }

type alertRuleModel struct {
	ID         types.String  `tfsdk:"id"`
	Name       types.String  `tfsdk:"name"`
	Signal     types.String  `tfsdk:"signal"`
	App        types.String  `tfsdk:"app"`
	Server     types.String  `tfsdk:"server"`
	Service    types.String  `tfsdk:"service"`
	Threshold  types.Float64 `tfsdk:"threshold"`
	ForSeconds types.Int64   `tfsdk:"for_seconds"`
	ChannelIDs types.Set     `tfsdk:"channel_ids"`
	Enabled    types.Bool    `tfsdk:"enabled"`
	IsDefault  types.Bool    `tfsdk:"is_default"`
	MutedUntil types.String  `tfsdk:"muted_until"`
	CreatedAt  types.String  `tfsdk:"created_at"`
}

// NewAlertRuleResource is the resource factory.
func NewAlertRuleResource() resource.Resource { return &alertRuleResource{} }

func (r *alertRuleResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_alert_rule"
}

func (r *alertRuleResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	c, err := clientFromProviderData(req.ProviderData)
	if err != nil {
		resp.Diagnostics.AddError("Unexpected provider data", err.Error())
		return
	}
	r.client = c
}

func (r *alertRuleResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	keep := []planmodifier.String{stringplanmodifier.UseStateForUnknown()}
	target := func(d string) schema.StringAttribute { return schema.StringAttribute{Optional: true, Description: d} }
	resp.Schema = schema.Schema{
		Description: "A swarmy alert rule: one signal (disk-usage, error-rate, service-down, …), optionally narrowed to one app, " +
			"part or server, sending to the given notification channels. Any member's key with the write scope can manage it; " +
			"destroying it runs the alert.remove policy step. Destroying an imported seeded default opts the org out of it.",
		Attributes: map[string]schema.Attribute{
			"id":   schema.StringAttribute{Computed: true, Description: "Rule ID.", PlanModifiers: keep},
			"name": schema.StringAttribute{Required: true, Description: "What the rule is called in the dashboard."},
			"signal": schema.StringAttribute{
				Required:      true,
				Description:   "What it watches (e.g. disk-usage, error-rate, service-down, node-offline, cert-expiry). Changing it forces a new rule.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"app":     target("App (stack) name, for app signals."),
			"server":  target("Server (node) name, for server signals."),
			"service": target("Part (service short name) inside `app`."),
			"threshold": schema.Float64Attribute{
				Optional:    true,
				Description: "The signal's threshold (percent, count, days, … per signal). Unset = none.",
			},
			"for_seconds": schema.Int64Attribute{
				Optional: true, Computed: true, Default: int64default.StaticInt64(0),
				Description: "How long the condition must hold before it fires, 0 to 86400.",
				Validators:  []validator.Int64{int64validator.Between(0, 86_400)},
			},
			"channel_ids": schema.SetAttribute{
				ElementType: types.StringType, Optional: true, Computed: true,
				Default:     setdefault.StaticValue(types.SetValueMust(types.StringType, []attr.Value{})),
				Description: "Notification channels it sends to (swarmy_notification_channel ids).",
			},
			"enabled":     schema.BoolAttribute{Optional: true, Computed: true, Default: booldefault.StaticBool(true), Description: "Defaults to true."},
			"is_default":  schema.BoolAttribute{Computed: true, Description: "One of the seeded per-signal rules (imported)."},
			"muted_until": schema.StringAttribute{Computed: true, Description: "Muted until then (RFC 3339), set in the dashboard; null = not muted."},
			"created_at":  schema.StringAttribute{Computed: true, Description: "When it was created (RFC 3339).", PlanModifiers: keep},
		},
	}
}

func (r *alertRuleResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan alertRuleModel
	if resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...); resp.Diagnostics.HasError() {
		return
	}
	body := alertRuleBody(ctx, &plan, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	rule, err := r.client.CreateAlertRule(ctx, body)
	if err != nil {
		resp.Diagnostics.AddError("Error creating alert rule", err.Error())
		return
	}
	resp.Diagnostics.Append(alertRuleToState(ctx, rule, &plan)...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *alertRuleResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state alertRuleModel
	if resp.Diagnostics.Append(req.State.Get(ctx, &state)...); resp.Diagnostics.HasError() {
		return
	}
	rule, err := r.client.GetAlertRule(ctx, state.ID.ValueString())
	if err != nil {
		if client.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Error reading alert rule", err.Error())
		return
	}
	resp.Diagnostics.Append(alertRuleToState(ctx, rule, &state)...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *alertRuleResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan alertRuleModel
	if resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...); resp.Diagnostics.HasError() {
		return
	}
	body := alertRuleBody(ctx, &plan, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	rule, err := r.client.UpdateAlertRule(ctx, plan.ID.ValueString(), body)
	if err != nil {
		resp.Diagnostics.AddError("Error updating alert rule", err.Error())
		return
	}
	resp.Diagnostics.Append(alertRuleToState(ctx, rule, &plan)...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *alertRuleResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state alertRuleModel
	if resp.Diagnostics.Append(req.State.Get(ctx, &state)...); resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteAlertRule(ctx, state.ID.ValueString()); err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Error deleting alert rule", err.Error())
	}
}

// ImportState adopts a rule by ID (a seeded default too).
func (r *alertRuleResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
