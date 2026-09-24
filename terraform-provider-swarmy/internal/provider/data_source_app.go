package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework/attr"
	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

var (
	_ datasource.DataSource              = (*appDataSource)(nil)
	_ datasource.DataSourceWithConfigure = (*appDataSource)(nil)
)

// appDataSource reads a GitOps app (a linked repo's swarmy.yaml): its
// environments and each one's latest plan status. Read-only — plans are
// confirmed in the dashboard or via POST /apps/plans/{id}/confirm.
type appDataSource struct {
	client *client.Client
}

type appDataSourceModel struct {
	RepoID          types.String `tfsdk:"repo_id"`
	URL             types.String `tfsdk:"url"`
	FullName        types.String `tfsdk:"full_name"`
	Branch          types.String `tfsdk:"branch"`
	ConfigPath      types.String `tfsdk:"config_path"`
	AppName         types.String `tfsdk:"app_name"`
	RequireApproval types.Bool   `tfsdk:"require_approval"`
	Environments    types.List   `tfsdk:"environments"`
}

var appEnvironmentAttrTypes = map[string]attr.Type{
	"environment":        types.StringType,
	"branch":             types.StringType,
	"stack":              types.StringType,
	"latest_plan_id":     types.StringType,
	"latest_plan_status": types.StringType,
	"latest_sha":         types.StringType,
	"latest_created_at":  types.StringType,
}

// NewAppDataSource is the data source factory.
func NewAppDataSource() datasource.DataSource {
	return &appDataSource{}
}

func (d *appDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_app"
}

func (d *appDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	c, err := clientFromProviderData(req.ProviderData)
	if err != nil {
		resp.Diagnostics.AddError("Unexpected provider data", err.Error())
		return
	}
	d.client = c
}

func (d *appDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	str := func(desc string) schema.StringAttribute {
		return schema.StringAttribute{Computed: true, Description: desc}
	}
	resp.Schema = schema.Schema{
		Description: "A GitOps app — the environments a linked repo's swarmy.yaml deploys and each environment's latest plan. Read-only.",
		Attributes: map[string]schema.Attribute{
			"repo_id": schema.StringAttribute{
				Required:    true,
				Description: "Linked repository ID (swarmy_git_repo.id).",
			},
			"url":              str("Clone URL."),
			"full_name":        str("Provider `owner/name`, when linked from a picker."),
			"branch":           str("Production branch."),
			"config_path":      str("swarmy.yaml path."),
			"app_name":         str("App (stack) name the swarmy.yaml declares; null until first planned."),
			"require_approval": schema.BoolAttribute{Computed: true, Description: "Every planned step waits for confirmation."},
			"environments": schema.ListNestedAttribute{
				Computed:    true,
				Description: "Environments with their latest plan.",
				NestedObject: schema.NestedAttributeObject{
					Attributes: map[string]schema.Attribute{
						"environment":        str("Environment name, e.g. production, staging."),
						"branch":             str("Branch that deploys this environment."),
						"stack":              str("Stack the environment deploys to."),
						"latest_plan_id":     str("Latest plan ID (null if never planned)."),
						"latest_plan_status": str("Latest plan status, e.g. applied, needs-confirmation, failed (open set)."),
						"latest_sha":         str("Commit the latest plan is for."),
						"latest_created_at":  str("When the latest plan was made (RFC 3339)."),
					},
				},
			},
		},
	}
}

func (d *appDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var cfg appDataSourceModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() {
		return
	}
	app, err := d.client.GetApp(ctx, cfg.RepoID.ValueString())
	if err != nil {
		resp.Diagnostics.AddError("Error reading app", err.Error())
		return
	}
	envs := make([]attr.Value, 0, len(app.Environments))
	for _, e := range app.Environments {
		obj, diags := types.ObjectValue(appEnvironmentAttrTypes, map[string]attr.Value{
			"environment":        types.StringValue(e.Environment),
			"branch":             types.StringValue(e.Branch),
			"stack":              types.StringValue(e.Stack),
			"latest_plan_id":     stringPtrToValue(e.LatestPlanID),
			"latest_plan_status": stringPtrToValue(e.LatestPlanStatus),
			"latest_sha":         stringPtrToValue(e.LatestSha),
			"latest_created_at":  stringPtrToValue(e.LatestCreatedAt),
		})
		resp.Diagnostics.Append(diags...)
		envs = append(envs, obj)
	}
	list, diags := types.ListValue(types.ObjectType{AttrTypes: appEnvironmentAttrTypes}, envs)
	resp.Diagnostics.Append(diags...)
	if resp.Diagnostics.HasError() {
		return
	}
	state := appDataSourceModel{
		RepoID:          types.StringValue(app.RepoID),
		URL:             types.StringValue(app.URL),
		FullName:        stringPtrToValue(app.FullName),
		Branch:          types.StringValue(app.Branch),
		ConfigPath:      types.StringValue(app.ConfigPath),
		AppName:         stringPtrToValue(app.AppName),
		RequireApproval: types.BoolValue(app.RequireApproval),
		Environments:    list,
	}
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}
