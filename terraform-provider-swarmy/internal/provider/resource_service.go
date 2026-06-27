package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

var (
	_ resource.Resource                = (*serviceResource)(nil)
	_ resource.ResourceWithConfigure   = (*serviceResource)(nil)
	_ resource.ResourceWithImportState = (*serviceResource)(nil)
)

// serviceResource manages swarmy_service.
type serviceResource struct {
	client *client.Client
}

// serviceModel is the Terraform state model for swarmy_service.
type serviceModel struct {
	ID       types.String `tfsdk:"id"`
	Name     types.String `tfsdk:"name"`
	Image    types.String `tfsdk:"image"`
	Replicas types.Int64  `tfsdk:"replicas"`
	Command  types.List   `tfsdk:"command"`
	Env      types.Map    `tfsdk:"env"`
	NodeID   types.String `tfsdk:"node_id"`
	Status   types.String `tfsdk:"status"`
}

// NewServiceResource is the resource factory.
func NewServiceResource() resource.Resource {
	return &serviceResource{}
}

func (r *serviceResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_service"
}

func (r *serviceResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	c, err := clientFromProviderData(req.ProviderData)
	if err != nil {
		resp.Diagnostics.AddError("Unexpected provider data", err.Error())
		return
	}
	r.client = c
}

func (r *serviceResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A swarmy service. Create/update dispatch an async deploy; the provider reads the service back to populate computed fields.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "Service ID.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"name": schema.StringAttribute{
				Required:      true,
				Description:   "Service name. Changing this forces a new service.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"image": schema.StringAttribute{
				Required:    true,
				Description: "Container image (e.g. nginx:1.27). Changing this redeploys the service in place.",
			},
			"replicas": schema.Int64Attribute{
				Optional:    true,
				Computed:    true,
				Description: "Desired replica count. Defaults to 1. Changes are applied via the scale endpoint.",
			},
			"command": schema.ListAttribute{
				Optional:    true,
				ElementType: types.StringType,
				Description: "Override command (argv). Set only at create time.",
			},
			"env": schema.MapAttribute{
				Optional:    true,
				ElementType: types.StringType,
				Description: "Environment variables as a key/value map.",
			},
			"node_id": schema.StringAttribute{
				Optional:    true,
				Computed:    true,
				Description: "Pin the service to a node. Changing this forces a new service.",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.RequiresReplace(),
					stringplanmodifier.UseStateForUnknown(),
				},
			},
			"status": schema.StringAttribute{
				Computed:    true,
				Description: "Current service status reported by the controller.",
			},
		},
	}
}

func (r *serviceResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan serviceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	body := client.CreateServiceRequest{
		Name:   plan.Name.ValueString(),
		Image:  plan.Image.ValueString(),
		NodeID: valueToStringPtr(plan.NodeID),
	}
	if !plan.Replicas.IsNull() && !plan.Replicas.IsUnknown() {
		rep := plan.Replicas.ValueInt64()
		body.Replicas = &rep
	}

	cmd, diags := listToStrings(ctx, plan.Command)
	resp.Diagnostics.Append(diags...)
	body.Command = cmd

	env, diags := mapToEnv(ctx, plan.Env)
	resp.Diagnostics.Append(diags...)
	body.Env = env
	if resp.Diagnostics.HasError() {
		return
	}

	ref, err := r.client.CreateService(ctx, body)
	if err != nil {
		resp.Diagnostics.AddError("Error creating service", err.Error())
		return
	}

	// The create is async (202) and returns the new service ID; read it back to
	// populate computed fields (status, replicas, node_id).
	svc, err := r.client.GetService(ctx, ref.ID)
	if err != nil {
		resp.Diagnostics.AddError("Error reading service after create", err.Error())
		return
	}

	r.mapServiceToState(svc, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *serviceResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state serviceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	svc, err := r.client.GetService(ctx, state.ID.ValueString())
	if err != nil {
		if client.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Error reading service", err.Error())
		return
	}

	r.mapServiceToState(svc, &state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *serviceResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state serviceModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	id := state.ID.ValueString()

	// Scale if the desired replica count changed.
	if !plan.Replicas.IsNull() && !plan.Replicas.IsUnknown() && plan.Replicas.ValueInt64() != state.Replicas.ValueInt64() {
		if _, err := r.client.ScaleService(ctx, id, plan.Replicas.ValueInt64()); err != nil {
			resp.Diagnostics.AddError("Error scaling service", err.Error())
			return
		}
	}

	// Redeploy if the image changed. The REST API exposes restart as the in-place
	// redeploy primitive; image changes are picked up on redeploy.
	if !plan.Image.Equal(state.Image) {
		if _, err := r.client.RestartService(ctx, id); err != nil {
			resp.Diagnostics.AddError("Error redeploying service", err.Error())
			return
		}
	}

	svc, err := r.client.GetService(ctx, id)
	if err != nil {
		resp.Diagnostics.AddError("Error reading service after update", err.Error())
		return
	}

	r.mapServiceToState(svc, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *serviceResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state serviceModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteService(ctx, state.ID.ValueString()); err != nil {
		if client.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Error deleting service", err.Error())
	}
}

func (r *serviceResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

// mapServiceToState copies API-managed fields onto the model. Image, command and
// env are kept from the plan/state because the read DTO does not echo them.
func (r *serviceResource) mapServiceToState(svc *client.Service, m *serviceModel) {
	m.ID = types.StringValue(svc.ID)
	m.Name = types.StringValue(svc.Name)
	m.Image = types.StringValue(svc.Image)
	m.Replicas = types.Int64Value(svc.Replicas.Desired)
	m.NodeID = stringPtrToValue(svc.NodeID)
	m.Status = types.StringValue(svc.Status)
}

// listToStrings flattens a types.List of strings.
func listToStrings(ctx context.Context, l types.List) ([]string, diag.Diagnostics) {
	if l.IsNull() || l.IsUnknown() {
		return nil, nil
	}
	var out []string
	d := l.ElementsAs(ctx, &out, false)
	return out, d
}

// mapToEnv converts a types.Map of strings into the API's []EnvVar shape.
func mapToEnv(ctx context.Context, m types.Map) ([]client.EnvVar, diag.Diagnostics) {
	if m.IsNull() || m.IsUnknown() {
		return nil, nil
	}
	raw := map[string]string{}
	d := m.ElementsAs(ctx, &raw, false)
	if d.HasError() {
		return nil, d
	}
	out := make([]client.EnvVar, 0, len(raw))
	for k, v := range raw {
		out = append(out, client.EnvVar{Key: k, Value: v})
	}
	return out, d
}
