package provider

import (
	"context"
	"regexp"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

var (
	_ resource.Resource                   = (*gitConnectionResource)(nil)
	_ resource.ResourceWithConfigure      = (*gitConnectionResource)(nil)
	_ resource.ResourceWithImportState    = (*gitConnectionResource)(nil)
	_ resource.ResourceWithValidateConfig = (*gitConnectionResource)(nil)
)

// gitConnectionResource manages swarmy_git_connection — token-based git
// provider connections only (GitLab access token, Gitea, generic git). GitHub
// App and GitLab OAuth connections need a browser; make them in the dashboard
// and reference their id.
type gitConnectionResource struct {
	client *client.Client
}

type gitConnectionModel struct {
	ID          types.String `tfsdk:"id"`
	Kind        types.String `tfsdk:"kind"`
	BaseURL     types.String `tfsdk:"base_url"`
	DisplayName types.String `tfsdk:"display_name"`
	Token       types.String `tfsdk:"token"`
	TokenUser   types.String `tfsdk:"token_user"`
	Account     types.String `tfsdk:"account"`
	Status      types.String `tfsdk:"status"`
	CreatedAt   types.String `tfsdk:"created_at"`
}

// NewGitConnectionResource is the resource factory.
func NewGitConnectionResource() resource.Resource {
	return &gitConnectionResource{}
}

func (r *gitConnectionResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_git_connection"
}

func (r *gitConnectionResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	c, err := clientFromProviderData(req.ProviderData)
	if err != nil {
		resp.Diagnostics.AddError("Unexpected provider data", err.Error())
		return
	}
	r.client = c
}

// replaceIfSet forces replacement when a write-only attribute changes AFTER it
// was recorded in state. When state holds null (e.g. right after `terraform
// import`, since the API never returns credentials) the new value is just
// adopted into state in place.
func replaceIfSet() planmodifier.String {
	return stringplanmodifier.RequiresReplaceIf(
		func(_ context.Context, req planmodifier.StringRequest, resp *stringplanmodifier.RequiresReplaceIfFuncResponse) {
			resp.RequiresReplace = !req.StateValue.IsNull()
		},
		"Replaces the resource when a previously-recorded write-only value changes.",
		"Replaces the resource when a previously-recorded write-only value changes.",
	)
}

func (r *gitConnectionResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "A token-based git provider connection (GitLab access token, Gitea, or generic git). " +
			"GitHub App and GitLab OAuth connections need a browser round-trip — create those in the dashboard. " +
			"The API has no update endpoint: changing any attribute replaces the connection. The token is write-only " +
			"(never read back), so after `terraform import` it is adopted from configuration without replacement.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "Git connection ID.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"kind": schema.StringAttribute{
				Required:      true,
				Description:   "Provider kind: gitlab (token), gitea, or generic.",
				Validators:    []validator.String{stringvalidator.OneOf("gitlab", "gitea", "generic")},
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"base_url": schema.StringAttribute{
				Optional:    true,
				Computed:    true,
				Description: "Provider base URL (http/https, no trailing slash). Defaults to https://gitlab.com for gitlab; required for gitea/generic.",
				Validators: []validator.String{
					stringvalidator.RegexMatches(regexp.MustCompile(`^https?://.*[^/]$`), "must be an http(s) URL without a trailing slash"),
				},
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
					stringplanmodifier.RequiresReplace(),
				},
			},
			"display_name": schema.StringAttribute{
				Optional:    true,
				Computed:    true,
				Description: "Display name (gitea/generic only; gitlab names itself after the host).",
				PlanModifiers: []planmodifier.String{
					stringplanmodifier.UseStateForUnknown(),
					stringplanmodifier.RequiresReplace(),
				},
			},
			"token": schema.StringAttribute{
				Optional:      true,
				Sensitive:     true,
				Description:   "Access token. Required for gitlab (verified against the provider on create), optional for gitea/generic. Write-only.",
				PlanModifiers: []planmodifier.String{replaceIfSet()},
			},
			"token_user": schema.StringAttribute{
				Optional:      true,
				Description:   "HTTP basic username the token is sent as (gitea/generic; server default `git`). Write-only.",
				PlanModifiers: []planmodifier.String{replaceIfSet()},
			},
			"account": schema.StringAttribute{
				Computed:      true,
				Description:   "Provider account the credential acts as, when known.",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"status": schema.StringAttribute{
				Computed:      true,
				Description:   "Connection status (active).",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
			"created_at": schema.StringAttribute{
				Computed:      true,
				Description:   "Creation timestamp (RFC 3339).",
				PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
			},
		},
	}
}

func (r *gitConnectionResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	var cfg gitConnectionModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &cfg)...)
	if resp.Diagnostics.HasError() || cfg.Kind.IsUnknown() || cfg.Kind.IsNull() {
		return
	}
	switch cfg.Kind.ValueString() {
	case "gitlab":
		if cfg.Token.IsNull() {
			resp.Diagnostics.AddAttributeError(path.Root("token"), "Missing token", "A gitlab connection needs an access token (OAuth connections are made in the dashboard).")
		}
		if !cfg.DisplayName.IsNull() {
			resp.Diagnostics.AddAttributeError(path.Root("display_name"), "Unsupported attribute", "display_name applies to gitea/generic connections only.")
		}
		if !cfg.TokenUser.IsNull() {
			resp.Diagnostics.AddAttributeError(path.Root("token_user"), "Unsupported attribute", "token_user applies to gitea/generic connections only.")
		}
	default:
		if cfg.BaseURL.IsNull() {
			resp.Diagnostics.AddAttributeError(path.Root("base_url"), "Missing base_url", "gitea and generic connections need base_url.")
		}
	}
}

func (r *gitConnectionResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan gitConnectionModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := client.CreateGitConnectionRequest{
		Kind:        plan.Kind.ValueString(),
		BaseURL:     valueToStringPtr(plan.BaseURL),
		DisplayName: valueToStringPtr(plan.DisplayName),
		Token:       valueToStringPtr(plan.Token),
		TokenUser:   valueToStringPtr(plan.TokenUser),
	}
	if body.Kind == "gitlab" {
		mode := "token"
		body.Mode = &mode
	}
	conn, err := r.client.CreateGitConnection(ctx, body)
	if err != nil {
		resp.Diagnostics.AddError("Error creating git connection", err.Error())
		return
	}
	mapGitConnectionToState(conn, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *gitConnectionResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state gitConnectionModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	conn, err := r.client.GetGitConnection(ctx, state.ID.ValueString())
	if err != nil {
		if client.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Error reading git connection", err.Error())
		return
	}
	// token / token_user are write-only: the state value is preserved.
	mapGitConnectionToState(conn, &state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Update only runs when a write-only attribute (token, token_user) moves from
// null to a value — i.e. adopting configuration after import. Every other change
// forces replacement, so there is nothing to send to the API.
func (r *gitConnectionResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan gitConnectionModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *gitConnectionResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state gitConnectionModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteGitConnection(ctx, state.ID.ValueString()); err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Error deleting git connection", err.Error())
	}
}

func (r *gitConnectionResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

func mapGitConnectionToState(c *client.GitConnection, m *gitConnectionModel) {
	m.ID = types.StringValue(c.ID)
	m.Kind = types.StringValue(c.Kind)
	m.BaseURL = types.StringValue(c.BaseURL)
	m.DisplayName = types.StringValue(c.DisplayName)
	m.Account = stringPtrToValue(c.Account)
	m.Status = types.StringValue(c.Status)
	m.CreatedAt = types.StringValue(c.CreatedAt)
}
