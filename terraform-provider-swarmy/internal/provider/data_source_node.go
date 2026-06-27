package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

var (
	_ datasource.DataSource              = (*nodeDataSource)(nil)
	_ datasource.DataSourceWithConfigure = (*nodeDataSource)(nil)
)

// nodeDataSource looks up a swarmy node by id or name.
type nodeDataSource struct {
	client *client.Client
}

// nodeDataSourceModel is the data source state model.
type nodeDataSourceModel struct {
	ID            types.String `tfsdk:"id"`
	Name          types.String `tfsdk:"name"`
	Hostname      types.String `tfsdk:"hostname"`
	Role          types.String `tfsdk:"role"`
	Status        types.String `tfsdk:"status"`
	EngineVersion types.String `tfsdk:"engine_version"`
	OS            types.String `tfsdk:"os"`
	Arch          types.String `tfsdk:"arch"`
	LastSeenAt    types.String `tfsdk:"last_seen_at"`
}

// NewNodeDataSource is the data source factory.
func NewNodeDataSource() datasource.DataSource {
	return &nodeDataSource{}
}

func (d *nodeDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_node"
}

func (d *nodeDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	c, err := clientFromProviderData(req.ProviderData)
	if err != nil {
		resp.Diagnostics.AddError("Unexpected provider data", err.Error())
		return
	}
	d.client = c
}

func (d *nodeDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Look up a swarmy node by id or name. Exactly one of id or name must be set.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Optional:    true,
				Computed:    true,
				Description: "Node ID. Set this or name.",
			},
			"name": schema.StringAttribute{
				Optional:    true,
				Computed:    true,
				Description: "Node name. Set this or id.",
			},
			"hostname": schema.StringAttribute{
				Computed:    true,
				Description: "Node hostname.",
			},
			"role": schema.StringAttribute{
				Computed:    true,
				Description: "Node role (manager or worker).",
			},
			"status": schema.StringAttribute{
				Computed:    true,
				Description: "Node status (pending, online, offline, draining).",
			},
			"engine_version": schema.StringAttribute{
				Computed:    true,
				Description: "Container engine version reported by the node.",
			},
			"os": schema.StringAttribute{
				Computed:    true,
				Description: "Operating system reported by the node.",
			},
			"arch": schema.StringAttribute{
				Computed:    true,
				Description: "CPU architecture reported by the node.",
			},
			"last_seen_at": schema.StringAttribute{
				Computed:    true,
				Description: "Timestamp the node was last seen.",
			},
		},
	}
}

func (d *nodeDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var cfg nodeDataSourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}

	hasID := !cfg.ID.IsNull() && cfg.ID.ValueString() != ""
	hasName := !cfg.Name.IsNull() && cfg.Name.ValueString() != ""
	if hasID == hasName {
		resp.Diagnostics.AddError(
			"Invalid swarmy_node lookup",
			"Exactly one of \"id\" or \"name\" must be set.",
		)
		return
	}

	var node *client.Node
	var err error
	if hasID {
		node, err = d.client.GetNode(ctx, cfg.ID.ValueString())
	} else {
		node, err = d.client.FindNodeByName(ctx, cfg.Name.ValueString())
	}
	if err != nil {
		resp.Diagnostics.AddError("Error looking up node", err.Error())
		return
	}

	state := nodeDataSourceModel{
		ID:            types.StringValue(node.ID),
		Name:          types.StringValue(node.Name),
		Hostname:      types.StringValue(node.Hostname),
		Role:          types.StringValue(node.Role),
		Status:        types.StringValue(node.Status),
		EngineVersion: stringPtrToValue(node.EngineVersion),
		OS:            stringPtrToValue(node.OS),
		Arch:          stringPtrToValue(node.Arch),
		LastSeenAt:    stringPtrToValue(node.LastSeenAt),
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}
