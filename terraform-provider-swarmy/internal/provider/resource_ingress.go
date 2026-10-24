package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

var (
	_ resource.ResourceWithConfigure   = (*ingressResource)(nil)
	_ resource.ResourceWithImportState = (*ingressResource)(nil)
)

// ingressResource manages swarmy_ingress: the org's edge settings, one per
// org (the API key's org). Create and update are one PUT /ingress/settings;
// destroy puts every setting back to its default.
type ingressResource struct{ client *client.Client }

// NewIngressResource is the resource factory.
func NewIngressResource() resource.Resource { return &ingressResource{} }

func (r *ingressResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_ingress"
}

func (r *ingressResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	c, err := clientFromProviderData(req.ProviderData)
	if err != nil {
		resp.Diagnostics.AddError("Unexpected provider data", err.Error())
		return
	}
	r.client = c
}

// put writes the planned settings (one PUT, one converge) and reads the
// answer back into m.
func (r *ingressResource) put(ctx context.Context, m *ingressModel, withSecrets bool, diags *diag.Diagnostics) {
	body, d := ingressBody(ctx, m, withSecrets)
	if diags.Append(d...); diags.HasError() {
		return
	}
	s, err := r.client.PutIngressSettings(ctx, body)
	if err != nil {
		diags.AddError("Error writing ingress settings", err.Error())
		return
	}
	diags.Append(mapIngressToState(ctx, s, m)...)
}

func (r *ingressResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan ingressModel
	if resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...); resp.Diagnostics.HasError() {
		return
	}
	r.put(ctx, &plan, true, &resp.Diagnostics)
	if !resp.Diagnostics.HasError() {
		resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
	}
}

func (r *ingressResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state ingressModel
	if resp.Diagnostics.Append(req.State.Get(ctx, &state)...); resp.Diagnostics.HasError() {
		return
	}
	s, err := r.client.GetIngressSettings(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Error reading ingress settings", err.Error())
		return
	}
	if resp.Diagnostics.Append(mapIngressToState(ctx, s, &state)...); !resp.Diagnostics.HasError() {
		resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
	}
}

func (r *ingressResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state ingressModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.Append(req.State.Get(ctx, &state)...); resp.Diagnostics.HasError() {
		return
	}
	r.put(ctx, &plan, secretsChanged(&plan, &state), &resp.Diagnostics)
	if !resp.Diagnostics.HasError() {
		resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
	}
}

// Delete puts every setting back to its default (the org keeps an edge; it
// can't have none).
func (r *ingressResource) Delete(ctx context.Context, _ resource.DeleteRequest, resp *resource.DeleteResponse) {
	if _, err := r.client.PutIngressSettings(ctx, client.DefaultIngressSettings()); err != nil {
		resp.Diagnostics.AddError("Error resetting ingress settings to defaults", err.Error())
	}
}

// ImportState adopts the org's settings. The ID is the org id (the API key's
// org; anything else is refused). Tokens can't be read, so they come back
// empty and the next apply writes the configured ones.
func (r *ingressResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	s, err := r.client.GetIngressSettings(ctx)
	if err != nil {
		resp.Diagnostics.AddError("Error reading ingress settings", err.Error())
		return
	}
	if req.ID != s.OrgID {
		resp.Diagnostics.AddError("Wrong org", fmt.Sprintf("This API key's org is %q, not %q: import swarmy_ingress by that org id.", s.OrgID, req.ID))
		return
	}
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), s.OrgID)...)
}
