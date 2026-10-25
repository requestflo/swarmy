package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64default"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

var (
	_ resource.ResourceWithConfigure   = (*policyResource)(nil)
	_ resource.ResourceWithImportState = (*policyResource)(nil)
)

// policyResource manages swarmy_policy over /policies: create is a POST,
// every change one PUT of the whole rule, destroy a DELETE. The controller
// validates the document and refuses a change that would lock owners out.
type policyResource struct{ client *client.Client }

// NewPolicyResource is the resource factory.
func NewPolicyResource() resource.Resource { return &policyResource{} }

func (r *policyResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_policy"
}

func (r *policyResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	c, err := clientFromProviderData(req.ProviderData)
	if err != nil {
		resp.Diagnostics.AddError("Unexpected provider data", err.Error())
		return
	}
	r.client = c
}

func (r *policyResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A swarmy access policy (ABAC): a permit or forbid rule over a JSON document. A forbid wins over every permit; " +
			"no permit means deny. Managing policies needs the policy.write permission (owners and admins by default). " +
			"The controller validates the document and refuses a change that would leave no owner able to change rules.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed: true, Description: "Policy ID.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name":        schema.StringAttribute{Required: true, Description: "What the rule is called."},
			"description": schema.StringAttribute{Optional: true, Description: "Why the rule exists."},
			"effect": schema.StringAttribute{
				Required: true, Description: "permit or forbid.",
				Validators: []validator.String{stringvalidator.OneOf("permit", "forbid")},
			},
			"source": schema.StringAttribute{
				Required:    true,
				Description: "The policy document as JSON (use jsonencode): roles, groups, members, actions, resourceTypes, resourceLabels, conditions, ….",
			},
			"priority": schema.Int64Attribute{
				Optional: true, Computed: true, Default: int64default.StaticInt64(0),
				Description: "Higher decides first, 0 to 1000. Defaults to 0.",
				Validators:  []validator.Int64{int64validator.Between(0, 1000)},
			},
			"enabled":    schema.BoolAttribute{Optional: true, Computed: true, Default: booldefault.StaticBool(true), Description: "Defaults to true."},
			"is_default": schema.BoolAttribute{Computed: true, Description: "A seeded default (imported): it may only be switched on or off."},
			"sentence":   schema.StringAttribute{Computed: true, Description: "The rule in plain words."},
			"updated_at": schema.StringAttribute{Computed: true, Description: "Last change (RFC 3339)."},
		},
	}
}

func (r *policyResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan policyModel
	if resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...); resp.Diagnostics.HasError() {
		return
	}
	p, err := r.client.CreatePolicy(ctx, policyBody(&plan))
	if err != nil {
		resp.Diagnostics.AddError("Error creating policy", err.Error())
		return
	}
	policyToState(p, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *policyResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state policyModel
	if resp.Diagnostics.Append(req.State.Get(ctx, &state)...); resp.Diagnostics.HasError() {
		return
	}
	p, err := r.client.GetPolicy(ctx, state.ID.ValueString())
	if err != nil {
		if client.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Error reading policy", err.Error())
		return
	}
	policyToState(p, &state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *policyResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan policyModel
	if resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...); resp.Diagnostics.HasError() {
		return
	}
	p, err := r.client.ReplacePolicy(ctx, plan.ID.ValueString(), policyBody(&plan))
	if err != nil {
		resp.Diagnostics.AddError("Error updating policy", err.Error())
		return
	}
	policyToState(p, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *policyResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state policyModel
	if resp.Diagnostics.Append(req.State.Get(ctx, &state)...); resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeletePolicy(ctx, state.ID.ValueString()); err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Error deleting policy", err.Error())
	}
}

// ImportState adopts a policy by ID.
func (r *policyResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
