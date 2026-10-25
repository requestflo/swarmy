package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/boolplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/mapplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

var (
	_ resource.ResourceWithConfigure   = (*guardrailsResource)(nil)
	_ resource.ResourceWithImportState = (*guardrailsResource)(nil)
)

// guardrailsResource manages swarmy_guardrails: the org's production-safety
// switch and the deploy rules it names, one per org (the API key's). Create
// and update are one PATCH /guardrails; destroy leaves the guardrails as they
// are, so removing the resource never weakens a safety rule.
type guardrailsResource struct{ client *client.Client }

// NewGuardrailsResource is the resource factory.
func NewGuardrailsResource() resource.Resource { return &guardrailsResource{} }

func (r *guardrailsResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_guardrails"
}

func (r *guardrailsResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	c, err := clientFromProviderData(req.ProviderData)
	if err != nil {
		resp.Diagnostics.AddError("Unexpected provider data", err.Error())
		return
	}
	r.client = c
}

func (r *guardrailsResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "The org's guardrails, one per org (the API key's; writing needs an admin's key with write): " +
			"production safety mode and the deploy rules named in `rules` (rules left out are not managed). " +
			"Each change is audited as in the dashboard. Destroy only removes them from state; the guardrails stay as they are.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed: true, Description: "The org id.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"production_safety_mode": schema.BoolAttribute{
				Optional: true, Computed: true, Default: booldefault.StaticBool(false),
				Description: "On: every rule is enforced at block on production stacks (swarmy.env=production). Defaults to false.",
			},
			"rules": schema.MapNestedAttribute{
				Optional:    true,
				Description: "Rules to manage, keyed by rule id (noLatestTagInProd, minDbReplicasProd, requireBackupPolicy, requireHealthcheck, requireResourceLimits, requireSignedImagesProd, noPrivilegedContainers, noHostPortsProd).",
				NestedObject: schema.NestedAttributeObject{Attributes: map[string]schema.Attribute{
					"enabled": schema.BoolAttribute{Required: true, Description: "Whether the rule runs."},
					"severity": schema.StringAttribute{
						Required: true, Description: "block (refuses the deploy) or warn (asks to confirm).",
						Validators: []validator.String{stringvalidator.OneOf("block", "warn")},
					},
					"params": schema.MapAttribute{
						ElementType: types.Int64Type, Optional: true, Computed: true,
						Description:   "Numeric parameters, e.g. { n = 2 } for minDbReplicasProd. Unset keeps the controller's.",
						PlanModifiers: []planmodifier.Map{mapplanmodifier.UseStateForUnknown()},
					},
					"prod_only": schema.BoolAttribute{
						Computed: true, Description: "Applies only to production stacks.",
						PlanModifiers: []planmodifier.Bool{boolplanmodifier.UseStateForUnknown()},
					},
				}},
			},
		},
	}
}

// write sends the planned switch + rules and reads the answer back into m.
func (r *guardrailsResource) write(ctx context.Context, m *guardrailsModel, diags *diag.Diagnostics) {
	body, d := guardrailsBody(ctx, m)
	if diags.Append(d...); diags.HasError() {
		return
	}
	g, err := r.client.UpdateGuardrails(ctx, body)
	if err != nil {
		diags.AddError("Error writing guardrails", err.Error())
		return
	}
	diags.Append(guardrailsToState(ctx, g, m)...)
}

func (r *guardrailsResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan guardrailsModel
	if resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...); resp.Diagnostics.HasError() {
		return
	}
	if r.write(ctx, &plan, &resp.Diagnostics); !resp.Diagnostics.HasError() {
		resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
	}
}

func (r *guardrailsResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state guardrailsModel
	if resp.Diagnostics.Append(req.State.Get(ctx, &state)...); resp.Diagnostics.HasError() {
		return
	}
	g, err := r.client.GetGuardrails(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Error reading guardrails", err.Error())
		return
	}
	if resp.Diagnostics.Append(guardrailsToState(ctx, g, &state)...); !resp.Diagnostics.HasError() {
		resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
	}
}

func (r *guardrailsResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan guardrailsModel
	if resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...); resp.Diagnostics.HasError() {
		return
	}
	if r.write(ctx, &plan, &resp.Diagnostics); !resp.Diagnostics.HasError() {
		resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
	}
}

// Delete forgets the guardrails: they keep running as last applied.
func (r *guardrailsResource) Delete(context.Context, resource.DeleteRequest, *resource.DeleteResponse) {
}

// ImportState adopts the org's guardrails by org id (the API key's org; any
// other is refused). No rule is managed until the configuration names it.
func (r *guardrailsResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	g, err := r.client.GetGuardrails(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Error reading guardrails", err.Error())
		return
	}
	if req.ID != g.OrgID {
		resp.Diagnostics.AddError("Wrong org", fmt.Sprintf("This API key's org is %q, not %q: import swarmy_guardrails by that org id.", g.OrgID, req.ID))
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), g.OrgID)...)
}
