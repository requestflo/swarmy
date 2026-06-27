package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

var (
	_ resource.Resource                = (*stackResource)(nil)
	_ resource.ResourceWithConfigure   = (*stackResource)(nil)
	_ resource.ResourceWithImportState = (*stackResource)(nil)
)

// stackResource manages swarmy_stack.
type stackResource struct {
	client *client.Client
}

// stackModel is the Terraform state model for swarmy_stack.
type stackModel struct {
	ID            types.String `tfsdk:"id"`
	Name          types.String `tfsdk:"name"`
	ComposeSource types.String `tfsdk:"compose_source"`
	ServiceCount  types.Int64  `tfsdk:"service_count"`
	Status        types.String `tfsdk:"status"`
}

// NewStackResource is the resource factory.
func NewStackResource() resource.Resource {
	return &stackResource{}
}

func (r *stackResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_stack"
}

func (r *stackResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	c, err := clientFromProviderData(req.ProviderData)
	if err != nil {
		resp.Diagnostics.AddError("Unexpected provider data", err.Error())
		return
	}
	r.client = c
}

func (r *stackResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A swarmy stack deployed from a compose document. Deploys are async; the provider reads the stack back to populate computed fields.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "Stack ID.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required:    true,
				Description: "Stack name.",
			},
			"compose_source": schema.StringAttribute{
				Required:    true,
				Description: "The compose document source that defines the stack.",
			},
			"service_count": schema.Int64Attribute{
				Computed:    true,
				Description: "Number of services in the stack.",
			},
			"status": schema.StringAttribute{
				Computed:    true,
				Description: "Current stack status reported by the controller.",
			},
		},
	}
}

func (r *stackResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan stackModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	ref, err := r.client.DeployStack(ctx, client.DeployStackRequest{
		Name:          plan.Name.ValueString(),
		ComposeSource: plan.ComposeSource.ValueString(),
	})
	if err != nil {
		resp.Diagnostics.AddError("Error deploying stack", err.Error())
		return
	}

	stack, err := r.client.GetStack(ctx, ref.ID)
	if err != nil {
		resp.Diagnostics.AddError("Error reading stack after create", err.Error())
		return
	}

	r.mapStackToState(stack, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *stackResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state stackModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	stack, err := r.client.GetStack(ctx, state.ID.ValueString())
	if err != nil {
		if client.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Error reading stack", err.Error())
		return
	}

	r.mapStackToState(stack, &state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *stackResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state stackModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	// A stack update is a redeploy of the new compose source under the same name.
	ref, err := r.client.DeployStack(ctx, client.DeployStackRequest{
		Name:          plan.Name.ValueString(),
		ComposeSource: plan.ComposeSource.ValueString(),
	})
	if err != nil {
		resp.Diagnostics.AddError("Error redeploying stack", err.Error())
		return
	}

	stack, err := r.client.GetStack(ctx, ref.ID)
	if err != nil {
		resp.Diagnostics.AddError("Error reading stack after update", err.Error())
		return
	}

	r.mapStackToState(stack, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *stackResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state stackModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteStack(ctx, state.ID.ValueString()); err != nil {
		if client.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Error deleting stack", err.Error())
	}
}

func (r *stackResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

// mapStackToState copies API-managed fields onto the model. compose_source is
// kept from plan/state because the read DTO does not echo it.
func (r *stackResource) mapStackToState(stack *client.Stack, m *stackModel) {
	m.ID = types.StringValue(stack.ID)
	m.Name = types.StringValue(stack.Name)
	m.ServiceCount = types.Int64Value(stack.ServiceCount)
	m.Status = types.StringValue(stack.Status)
}
