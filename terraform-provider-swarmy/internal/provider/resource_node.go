package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

var (
	_ resource.Resource                = (*nodeResource)(nil)
	_ resource.ResourceWithConfigure   = (*nodeResource)(nil)
	_ resource.ResourceWithImportState = (*nodeResource)(nil)
)

// Swarm availability values the REST API can set.
const (
	availabilityActive = "active"
	availabilityDrain  = "drain"
)

// nodeResource manages swarmy_node: the labels and availability of a node
// that already joined (nodes enrol through the agent install, not the API).
type nodeResource struct {
	client *client.Client
}

// nodeModel is the Terraform state model for swarmy_node.
type nodeModel struct {
	ID              types.String `tfsdk:"id"`
	NodeID          types.String `tfsdk:"node_id"`
	Labels          types.Map    `tfsdk:"labels"`
	Availability    types.String `tfsdk:"availability"`
	RemoveOnDestroy types.Bool   `tfsdk:"remove_on_destroy"`
	Name            types.String `tfsdk:"name"`
	Hostname        types.String `tfsdk:"hostname"`
	Role            types.String `tfsdk:"role"`
	Status          types.String `tfsdk:"status"`
	EngineVersion   types.String `tfsdk:"engine_version"`
	OS              types.String `tfsdk:"os"`
	Arch            types.String `tfsdk:"arch"`
	LastSeenAt      types.String `tfsdk:"last_seen_at"`
}

// NewNodeResource is the resource factory.
func NewNodeResource() resource.Resource {
	return &nodeResource{}
}

func (r *nodeResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_node"
}

func (r *nodeResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	c, err := clientFromProviderData(req.ProviderData)
	if err != nil {
		resp.Diagnostics.AddError("Unexpected provider data", err.Error())
		return
	}
	r.client = c
}

func (r *nodeResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	computed := func(desc string) schema.StringAttribute {
		return schema.StringAttribute{Computed: true, Description: desc}
	}
	resp.Schema = schema.Schema{
		Description: "Manage an existing swarmy node's labels and availability. Nodes join through the agent install (a join token), not the API, so creating this resource adopts the node named by node_id and destroying it only stops managing it unless remove_on_destroy is set.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "Node ID (same as node_id).",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"node_id": schema.StringAttribute{
				Required:      true,
				Description:   "ID of the node to manage, e.g. from data.swarmy_node. Changing this forces a new resource.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"labels": schema.MapAttribute{
				Optional:    true,
				ElementType: types.StringType,
				Description: "Swarm node labels to set. Only these keys are managed; other labels on the node are left alone. The API merges labels and cannot delete a key, so a label removed from this map is blanked (set to \"\"). The node read does not return labels, so changes made outside Terraform are not detected. Capability labels (swarmy.node.exec, swarmy.node.shell, swarmy.node.diskFormat) are refused by the API.",
			},
			"availability": schema.StringAttribute{
				Optional:      true,
				Computed:      true,
				Description:   "Scheduling availability: active, or drain (no new tasks; running tasks move off). Left as-is when unset.",
				Validators:    []validator.String{stringvalidator.OneOf(availabilityActive, availabilityDrain)},
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"remove_on_destroy": schema.BoolAttribute{
				Optional:    true,
				Computed:    true,
				Default:     booldefault.StaticBool(false),
				Description: "On destroy, remove the node from swarmy (DELETE /nodes/{id}) instead of only forgetting it. The controller refuses for the swarm's only manager or the node running the controller. Default false.",
			},
			"name":           computed("Node name."),
			"hostname":       computed("Node hostname."),
			"role":           computed("Node role (manager or worker)."),
			"status":         computed("Node status (pending, online, offline, draining)."),
			"engine_version": computed("Container engine version reported by the node."),
			"os":             computed("Operating system reported by the node."),
			"arch":           computed("CPU architecture reported by the node."),
			"last_seen_at":   computed("Timestamp the node was last seen."),
		},
	}
}

func (r *nodeResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan nodeModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	id := plan.NodeID.ValueString()

	node, err := r.client.GetNode(ctx, id)
	if err != nil {
		if client.IsNotFound(err) {
			resp.Diagnostics.AddAttributeError(path.Root("node_id"), "Node not found",
				"No node "+id+" in this org. Nodes join through the agent install (a join token from the dashboard); look them up with data.swarmy_node.")
			return
		}
		resp.Diagnostics.AddError("Error reading node", err.Error())
		return
	}

	labels, diags := mapToStrings(ctx, plan.Labels)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	if len(labels) > 0 {
		if _, err := r.client.SetNodeLabels(ctx, id, labels); err != nil {
			resp.Diagnostics.AddError("Error setting node labels", err.Error())
			return
		}
	}
	if !r.applyAvailability(ctx, id, plan.Availability, availabilityOf(node), &resp.Diagnostics) {
		return
	}

	r.readInto(ctx, id, &plan, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *nodeResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state nodeModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}

	node, err := r.client.GetNode(ctx, state.ID.ValueString())
	if err != nil {
		if client.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Error reading node", err.Error())
		return
	}
	mapNodeToState(node, &state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *nodeResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state nodeModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	id := state.ID.ValueString()

	if !plan.Labels.Equal(state.Labels) {
		want, diags := mapToStrings(ctx, plan.Labels)
		resp.Diagnostics.Append(diags...)
		had, diags := mapToStrings(ctx, state.Labels)
		resp.Diagnostics.Append(diags...)
		if resp.Diagnostics.HasError() {
			return
		}
		if patch := labelPatch(had, want); len(patch) > 0 {
			if _, err := r.client.SetNodeLabels(ctx, id, patch); err != nil {
				resp.Diagnostics.AddError("Error setting node labels", err.Error())
				return
			}
		}
	}
	if !r.applyAvailability(ctx, id, plan.Availability, state.Availability.ValueString(), &resp.Diagnostics) {
		return
	}

	r.readInto(ctx, id, &plan, &resp.Diagnostics)
	if resp.Diagnostics.HasError() {
		return
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *nodeResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state nodeModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	// Default: stop managing the node; its labels and availability stay as they are.
	if !state.RemoveOnDestroy.ValueBool() {
		return
	}
	if err := r.client.RemoveNode(ctx, state.ID.ValueString()); err != nil {
		if client.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Error removing node", err.Error())
	}
}

// ImportState adopts a node by ID. Labels are not readable over the API, so
// they come back empty and the next apply writes the configured ones.
func (r *nodeResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("node_id"), req.ID)...)
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("remove_on_destroy"), false)...)
}

// applyAvailability drains or uncordons the node when the planned availability
// differs from the current one. It reports false after adding an error.
func (r *nodeResource) applyAvailability(ctx context.Context, id string, want types.String, current string, diags *diag.Diagnostics) bool {
	if want.IsNull() || want.IsUnknown() || want.ValueString() == current {
		return true
	}
	var err error
	if want.ValueString() == availabilityDrain {
		_, err = r.client.DrainNode(ctx, id)
	} else {
		_, err = r.client.UncordonNode(ctx, id)
	}
	if err != nil {
		diags.AddError("Error setting node availability to "+want.ValueString(), err.Error())
		return false
	}
	return true
}

// readInto reads the node back into m, keeping the configured availability:
// the drain/uncordon is dispatched to a manager and the read can lag it.
func (r *nodeResource) readInto(ctx context.Context, id string, m *nodeModel, diags *diag.Diagnostics) {
	node, err := r.client.GetNode(ctx, id)
	if err != nil {
		diags.AddError("Error reading node", err.Error())
		return
	}
	want := m.Availability
	mapNodeToState(node, m)
	if !want.IsNull() && !want.IsUnknown() {
		m.Availability = want
	}
}

// mapNodeToState copies the node's API fields onto the model. Labels are kept
// from plan/state: the Node DTO does not return them.
func mapNodeToState(n *client.Node, m *nodeModel) {
	m.ID = types.StringValue(n.ID)
	m.NodeID = types.StringValue(n.ID)
	m.Availability = types.StringValue(availabilityOf(n))
	if m.RemoveOnDestroy.IsNull() || m.RemoveOnDestroy.IsUnknown() {
		m.RemoveOnDestroy = types.BoolValue(false)
	}
	m.Name = types.StringValue(n.Name)
	m.Hostname = types.StringValue(n.Hostname)
	m.Role = types.StringValue(n.Role)
	m.Status = types.StringValue(n.Status)
	m.EngineVersion = stringPtrToValue(n.EngineVersion)
	m.OS = stringPtrToValue(n.OS)
	m.Arch = stringPtrToValue(n.Arch)
	m.LastSeenAt = stringPtrToValue(n.LastSeenAt)
}

// availabilityOf derives availability from the node status: the controller
// reports "draining" exactly when the swarm node's availability is drain.
func availabilityOf(n *client.Node) string {
	if n.Status == "draining" {
		return availabilityDrain
	}
	return availabilityActive
}

// labelPatch is the PUT body that moves the node from the had labels to the
// want labels: changed or new keys, plus removed keys blanked (the API merges
// and cannot delete).
func labelPatch(had, want map[string]string) map[string]string {
	patch := map[string]string{}
	for k, v := range want {
		if old, ok := had[k]; !ok || old != v {
			patch[k] = v
		}
	}
	for k := range had {
		if _, ok := want[k]; !ok {
			patch[k] = ""
		}
	}
	return patch
}

// mapToStrings flattens a types.Map of strings (null/unknown → nil).
func mapToStrings(ctx context.Context, m types.Map) (map[string]string, diag.Diagnostics) {
	if m.IsNull() || m.IsUnknown() {
		return nil, nil
	}
	out := map[string]string{}
	d := m.ElementsAs(ctx, &out, false)
	return out, d
}
