package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/resourcevalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/boolplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

var (
	_ resource.Resource                     = (*gitRepoResource)(nil)
	_ resource.ResourceWithConfigure        = (*gitRepoResource)(nil)
	_ resource.ResourceWithImportState      = (*gitRepoResource)(nil)
	_ resource.ResourceWithConfigValidators = (*gitRepoResource)(nil)
)

// gitRepoResource manages swarmy_git_repo — a linked repository (branch +
// swarmy.yaml path) that swarmy's GitOps loop applies.
type gitRepoResource struct {
	client *client.Client
}

type gitRepoModel struct {
	ID              types.String `tfsdk:"id"`
	ConnectionID    types.String `tfsdk:"connection_id"`
	RepoID          types.String `tfsdk:"repo_id"`
	FullName        types.String `tfsdk:"full_name"`
	CloneURL        types.String `tfsdk:"clone_url"`
	URL             types.String `tfsdk:"url"`
	Branch          types.String `tfsdk:"branch"`
	ConfigPath      types.String `tfsdk:"config_path"`
	DeployKey       types.Bool   `tfsdk:"deploy_key"`
	RequireApproval types.Bool   `tfsdk:"require_approval"`
	Kind            types.String `tfsdk:"kind"`
	WebhookURL      types.String `tfsdk:"webhook_url"`
	WebhookSecret   types.String `tfsdk:"webhook_secret"`
	DeployKeyPublic types.String `tfsdk:"deploy_key_public"`
	CreatedAt       types.String `tfsdk:"created_at"`
}

// NewGitRepoResource is the resource factory.
func NewGitRepoResource() resource.Resource {
	return &gitRepoResource{}
}

func (r *gitRepoResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_git_repo"
}

func (r *gitRepoResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	c, err := clientFromProviderData(req.ProviderData)
	if err != nil {
		resp.Diagnostics.AddError("Unexpected provider data", err.Error())
		return
	}
	r.client = c
}

func (r *gitRepoResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	replace := []planmodifier.String{stringplanmodifier.RequiresReplace()}
	computedReplace := []planmodifier.String{stringplanmodifier.UseStateForUnknown(), stringplanmodifier.RequiresReplace()}
	keep := []planmodifier.String{stringplanmodifier.UseStateForUnknown()}
	resp.Schema = schema.Schema{
		Description: "A repository linked to swarmy as an app binding (branch + swarmy.yaml path). Give either a picked " +
			"provider repo (`connection_id` + `repo_id` + `full_name` + `clone_url`, from the connection's repo listing) or a " +
			"raw `url`. `webhook_secret` and " +
			"`deploy_key_public` are returned ONCE on create and kept in state; they are null after `terraform import`. " +
			"`branch`, `config_path` and `require_approval` update in place; anything else re-links the repo.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "Linked repository ID.",
				PlanModifiers: keep,
			},
			"connection_id": schema.StringAttribute{
				Optional:      true,
				Description:   "Git connection the repo authenticates through (swarmy_git_connection.id, or a dashboard-made GitHub/GitLab connection id).",
				PlanModifiers: replace,
			},
			"repo_id": schema.StringAttribute{
				Optional:      true,
				Description:   "Provider repo id (picked repo). Requires full_name and clone_url. Not read back (adopted from config after import).",
				PlanModifiers: []planmodifier.String{replaceIfSet()},
			},
			"full_name": schema.StringAttribute{
				Optional:      true,
				Description:   "Provider repo `owner/name` (picked repo).",
				PlanModifiers: replace,
			},
			"clone_url": schema.StringAttribute{
				Optional:      true,
				Description:   "Provider clone URL (picked repo).",
				PlanModifiers: []planmodifier.String{replaceIfSet()},
			},
			"url": schema.StringAttribute{
				Optional:      true,
				Computed:      true,
				Description:   "Raw clone URL (generic git). Computed from clone_url for a picked repo.",
				PlanModifiers: computedReplace,
			},
			"branch": schema.StringAttribute{
				Required:    true,
				Description: "Branch to track (production). Updated in place.",
			},
			"config_path": schema.StringAttribute{
				Optional:      true,
				Computed:      true,
				Description:   "Path of the swarmy.yaml to apply (default swarmy.yaml). Updated in place.",
				PlanModifiers: keep,
			},
			"require_approval": schema.BoolAttribute{
				Optional:      true,
				Computed:      true,
				Description:   "GitOps: every planned step waits for confirmation in the dashboard (not only destructive ones). Updated in place; admin/owner key required.",
				PlanModifiers: []planmodifier.Bool{boolplanmodifier.UseStateForUnknown()},
			},
			"deploy_key": schema.BoolAttribute{
				Optional:      true,
				Description:   "Mint an ed25519 deploy key (SSH remotes); its public half lands in deploy_key_public. Not read back (adopted from config after import).",
				PlanModifiers: []planmodifier.Bool{boolReplaceIfSet()},
			},
			"kind": schema.StringAttribute{
				Computed:      true,
				Description:   "Provider kind: github, gitlab, gitea, or generic.",
				PlanModifiers: keep,
			},
			"webhook_url": schema.StringAttribute{
				Computed:      true,
				Description:   "Webhook URL to configure on the git host, when swarmy could not register it itself (null otherwise). Returned once.",
				PlanModifiers: keep,
			},
			"webhook_secret": schema.StringAttribute{
				Computed:      true,
				Sensitive:     true,
				Description:   "Webhook HMAC secret for webhook_url. Returned ONCE on create.",
				PlanModifiers: keep,
			},
			"deploy_key_public": schema.StringAttribute{
				Computed:      true,
				Description:   "Public deploy key to add to the git host. Returned ONCE on create.",
				PlanModifiers: keep,
			},
			"created_at": schema.StringAttribute{
				Computed:      true,
				Description:   "Creation timestamp (RFC 3339).",
				PlanModifiers: keep,
			},
		},
	}
}

// boolReplaceIfSet is replaceIfSet for a create-only bool input.
func boolReplaceIfSet() planmodifier.Bool {
	return boolplanmodifier.RequiresReplaceIf(
		func(_ context.Context, req planmodifier.BoolRequest, resp *boolplanmodifier.RequiresReplaceIfFuncResponse) {
			resp.RequiresReplace = !req.StateValue.IsNull()
		},
		"Replaces the resource when a previously-recorded create-only value changes.",
		"Replaces the resource when a previously-recorded create-only value changes.",
	)
}

func (r *gitRepoResource) ConfigValidators(_ context.Context) []resource.ConfigValidator {
	return []resource.ConfigValidator{
		resourcevalidator.ExactlyOneOf(path.MatchRoot("url"), path.MatchRoot("repo_id")),
		resourcevalidator.RequiredTogether(path.MatchRoot("repo_id"), path.MatchRoot("full_name"), path.MatchRoot("clone_url")),
	}
}

func (r *gitRepoResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan gitRepoModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}
	body := client.LinkGitRepoRequest{
		ConnectionID: valueToStringPtr(plan.ConnectionID),
		Branch:       plan.Branch.ValueString(),
		ConfigPath:   valueToStringPtr(plan.ConfigPath),
	}
	if !plan.RepoID.IsNull() && !plan.RepoID.IsUnknown() {
		body.Repo = &client.GitRepoRef{
			ID:       plan.RepoID.ValueString(),
			FullName: plan.FullName.ValueString(),
			CloneURL: plan.CloneURL.ValueString(),
		}
	} else {
		body.URL = valueToStringPtr(plan.URL)
	}
	if !plan.DeployKey.IsNull() && !plan.DeployKey.IsUnknown() {
		v := plan.DeployKey.ValueBool()
		body.DeployKey = &v
	}
	linked, err := r.client.LinkGitRepo(ctx, body)
	if err != nil {
		resp.Diagnostics.AddError("Error linking git repository", err.Error())
		return
	}
	plan.ID = types.StringValue(linked.ID)
	plan.URL = types.StringValue(linked.URL)
	plan.Branch = types.StringValue(linked.Branch)
	plan.ConfigPath = types.StringValue(linked.ConfigPath)
	plan.DeployKeyPublic = stringPtrToValue(linked.DeployKeyPublic)
	if linked.Webhook != nil {
		plan.WebhookURL = types.StringValue(linked.Webhook.URL)
		plan.WebhookSecret = types.StringValue(linked.Webhook.Secret)
	} else {
		plan.WebhookURL = types.StringNull()
		plan.WebhookSecret = types.StringNull()
	}
	if !plan.RequireApproval.IsNull() && !plan.RequireApproval.IsUnknown() && plan.RequireApproval.ValueBool() {
		if err := r.client.SetAppRequireApproval(ctx, linked.ID, true); err != nil {
			// The repo exists now: record it so a re-apply converges instead of leaking it.
			plan.RequireApproval = types.BoolValue(false)
			r.fillFromRead(ctx, linked.ID, &plan, resp)
			resp.Diagnostics.AddError("Error setting require_approval on linked git repository", err.Error())
			return
		}
	}
	r.fillFromRead(ctx, linked.ID, &plan, resp)
}

// fillFromRead completes Create's state from the detail read (kind,
// created_at, require_approval) and saves it.
func (r *gitRepoResource) fillFromRead(ctx context.Context, id string, plan *gitRepoModel, resp *resource.CreateResponse) {
	repo, err := r.client.GetGitRepo(ctx, id)
	if err != nil {
		resp.Diagnostics.AddError("Error reading linked git repository", err.Error())
		// Save what we know (no unknowns) so the linked repo is tracked, not leaked.
		plan.Kind, plan.CreatedAt = types.StringNull(), types.StringNull()
		if plan.RequireApproval.IsUnknown() {
			plan.RequireApproval = types.BoolNull()
		}
		resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
		return
	}
	plan.Kind = types.StringValue(repo.Kind)
	plan.CreatedAt = types.StringValue(repo.CreatedAt)
	plan.RequireApproval = types.BoolValue(repo.RequireApproval)
	resp.Diagnostics.Append(resp.State.Set(ctx, plan)...)
}

func (r *gitRepoResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state gitRepoModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	repo, err := r.client.GetGitRepo(ctx, state.ID.ValueString())
	if err != nil {
		if client.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Error reading git repository", err.Error())
		return
	}
	mapGitRepoToState(repo, &state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Update applies branch / config_path (PATCH /git/repos/{id}) and
// require_approval (PUT /apps/{id}/require-approval) in place. Create-only
// inputs (repo_id, clone_url, deploy_key) only reach here moving from null to a
// value after import, and are simply adopted into state.
func (r *gitRepoResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state gitRepoModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	id := state.ID.ValueString()
	var patch client.UpdateGitRepoRequest
	if !plan.Branch.Equal(state.Branch) {
		patch.Branch = valueToStringPtr(plan.Branch)
	}
	if !plan.ConfigPath.IsUnknown() && !plan.ConfigPath.IsNull() && !plan.ConfigPath.Equal(state.ConfigPath) {
		patch.ConfigPath = valueToStringPtr(plan.ConfigPath)
	}
	if patch.Branch != nil || patch.ConfigPath != nil {
		if _, err := r.client.UpdateGitRepo(ctx, id, patch); err != nil {
			resp.Diagnostics.AddError("Error updating git repository", err.Error())
			return
		}
	}
	if !plan.RequireApproval.IsUnknown() && !plan.RequireApproval.IsNull() && !plan.RequireApproval.Equal(state.RequireApproval) {
		if err := r.client.SetAppRequireApproval(ctx, id, plan.RequireApproval.ValueBool()); err != nil {
			resp.Diagnostics.AddError("Error setting require_approval", err.Error())
			return
		}
	}
	repo, err := r.client.GetGitRepo(ctx, id)
	if err != nil {
		resp.Diagnostics.AddError("Error reading git repository", err.Error())
		return
	}
	mapGitRepoToState(repo, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *gitRepoResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state gitRepoModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteGitRepo(ctx, state.ID.ValueString()); err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Error unlinking git repository", err.Error())
	}
}

func (r *gitRepoResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

// mapGitRepoToState refreshes the readable attributes. The write-once fields
// (webhook_*, deploy_key_public) and create-only inputs (repo_id, clone_url,
// deploy_key) are never returned by a read, so their state values are kept.
// On import, a picked repo's clone_url is recovered from url.
func mapGitRepoToState(g *client.GitRepo, m *gitRepoModel) {
	m.ID = types.StringValue(g.ID)
	m.Kind = types.StringValue(g.Kind)
	m.URL = types.StringValue(g.URL)
	m.Branch = types.StringValue(g.Branch)
	m.ConfigPath = types.StringValue(g.ConfigPath)
	m.RequireApproval = types.BoolValue(g.RequireApproval)
	m.ConnectionID = stringPtrToValue(g.ConnectionID)
	m.FullName = stringPtrToValue(g.FullName)
	m.CreatedAt = types.StringValue(g.CreatedAt)
	if g.FullName != nil && m.CloneURL.IsNull() {
		m.CloneURL = types.StringValue(g.URL)
	}
	if m.WebhookURL.IsUnknown() {
		m.WebhookURL = types.StringNull()
	}
	if m.WebhookSecret.IsUnknown() {
		m.WebhookSecret = types.StringNull()
	}
	if m.DeployKeyPublic.IsUnknown() {
		m.DeployKeyPublic = types.StringNull()
	}
}
