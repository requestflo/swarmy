package provider

import (
	"context"
	"math"
	"time"

	"github.com/hashicorp/terraform-plugin-framework-validators/int64validator"
	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

var (
	_ resource.Resource                = (*joinTokenResource)(nil)
	_ resource.ResourceWithConfigure   = (*joinTokenResource)(nil)
	_ resource.ResourceWithImportState = (*joinTokenResource)(nil)
)

// joinTokenResource manages swarmy_join_token. A join token is immutable on
// the controller, so every argument forces a new token; destroy revokes it.
type joinTokenResource struct {
	client *client.Client
}

type joinTokenModel struct {
	ID           types.String `tfsdk:"id"`
	Label        types.String `tfsdk:"label"`
	TTLSeconds   types.Int64  `tfsdk:"ttl_seconds"`
	MaxUses      types.Int64  `tfsdk:"max_uses"`
	Profile      types.String `tfsdk:"profile"`
	Token        types.String `tfsdk:"token"`
	MeshSetupKey types.String `tfsdk:"mesh_setup_key"`
	InstallURL   types.String `tfsdk:"install_url"`
	TokenPrefix  types.String `tfsdk:"token_prefix"`
	CreatedAt    types.String `tfsdk:"created_at"`
	ExpiresAt    types.String `tfsdk:"expires_at"`
	UsedCount    types.Int64  `tfsdk:"used_count"`
	Status       types.String `tfsdk:"status"`
}

// NewJoinTokenResource is the resource factory.
func NewJoinTokenResource() resource.Resource {
	return &joinTokenResource{}
}

func (r *joinTokenResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_join_token"
}

func (r *joinTokenResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	c, err := clientFromProviderData(req.ProviderData)
	if err != nil {
		resp.Diagnostics.AddError("Unexpected provider data", err.Error())
		return
	}
	r.client = c
}

func (r *joinTokenResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	keep := []planmodifier.String{stringplanmodifier.UseStateForUnknown()}
	replace := []planmodifier.String{stringplanmodifier.RequiresReplace()}
	resp.Schema = schema.Schema{
		Description: "A swarmy join token: what a new server's agent installer presents (SWARMY_JOIN_TOKEN) to enroll. " +
			"Minting needs an admin's API key with the write scope. The token is returned only on creation and stored (sensitive) in state. " +
			"Every argument forces a new token; destroy revokes it. A token revoked outside Terraform is recreated on the next apply; " +
			"an expired or used-up one stays (see status) until you replace it.",
		Attributes: map[string]schema.Attribute{
			"id": schema.StringAttribute{
				Computed:      true,
				Description:   "Join token ID.",
				PlanModifiers: keep,
			},
			"label": schema.StringAttribute{
				Optional:      true,
				Description:   "What the token is for (shown in the dashboard).",
				Validators:    []validator.String{stringvalidator.LengthAtMost(80)},
				PlanModifiers: replace,
			},
			"ttl_seconds": schema.Int64Attribute{
				Optional:      true,
				Computed:      true,
				Description:   "Lifetime in seconds, 60 to 604800 (7 days). Defaults to 3600.",
				Validators:    []validator.Int64{int64validator.Between(60, 604_800)},
				PlanModifiers: []planmodifier.Int64{int64planmodifier.UseStateForUnknown(), int64planmodifier.RequiresReplace()},
			},
			"max_uses": schema.Int64Attribute{
				Optional:      true,
				Computed:      true,
				Description:   "How many servers may join with it, 1 to 100. Defaults to 1. While the org runs a mesh the controller makes every token single-use.",
				Validators:    []validator.Int64{int64validator.Between(1, 100)},
				PlanModifiers: []planmodifier.Int64{int64planmodifier.UseStateForUnknown(), int64planmodifier.RequiresReplace()},
			},
			"profile": schema.StringAttribute{
				Optional:      true,
				Description:   "Install profile, the label bundle servers enroll with: edge, storage, database or private-mesh. Omit for the default.",
				Validators:    []validator.String{stringvalidator.OneOf("edge", "storage", "database", "private-mesh")},
				PlanModifiers: replace,
			},
			"token": schema.StringAttribute{
				Computed:      true,
				Sensitive:     true,
				Description:   "The plaintext join token (swt_…). Only available on creation; null after import.",
				PlanModifiers: keep,
			},
			"mesh_setup_key": schema.StringAttribute{
				Computed:      true,
				Sensitive:     true,
				Description:   "Set when the org runs a mesh: the one-use key the server joins the mesh with (SWARMY_MESH_SETUP_KEY). Only available on creation.",
				PlanModifiers: keep,
			},
			"install_url": schema.StringAttribute{
				Computed:      true,
				Description:   "The controller URL the installer should use (`curl -fsSL <install_url>/install/loader.sh | SWARMY_JOIN_TOKEN=… sh -s -- --controller <install_url>`). Only available on creation.",
				PlanModifiers: keep,
			},
			"token_prefix": schema.StringAttribute{
				Computed:      true,
				Description:   "The token's displayed prefix.",
				PlanModifiers: keep,
			},
			"created_at": schema.StringAttribute{
				Computed:      true,
				Description:   "When the token was minted (RFC 3339).",
				PlanModifiers: keep,
			},
			"expires_at": schema.StringAttribute{
				Computed:      true,
				Description:   "When the token stops enrolling servers (RFC 3339).",
				PlanModifiers: keep,
			},
			"used_count": schema.Int64Attribute{
				Computed:    true,
				Description: "Servers that joined with it so far.",
			},
			"status": schema.StringAttribute{
				Computed:    true,
				Description: "active, expired or exhausted (open set).",
			},
		},
	}
}

func (r *joinTokenResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan joinTokenModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.HasError() {
		return
	}

	body := client.CreateJoinTokenRequest{
		Label:   valueToStringPtr(plan.Label),
		Profile: valueToStringPtr(plan.Profile),
	}
	if !plan.TTLSeconds.IsNull() && !plan.TTLSeconds.IsUnknown() {
		v := plan.TTLSeconds.ValueInt64()
		body.TTLSeconds = &v
	}
	if !plan.MaxUses.IsNull() && !plan.MaxUses.IsUnknown() {
		v := plan.MaxUses.ValueInt64()
		body.MaxUses = &v
	}

	issued, err := r.client.CreateJoinToken(ctx, body)
	if err != nil {
		resp.Diagnostics.AddError("Error creating join token", err.Error())
		return
	}
	plan.ID = types.StringValue(issued.ID)
	plan.Token = types.StringValue(issued.Token)
	plan.InstallURL = types.StringValue(issued.Install.URL)
	plan.MeshSetupKey = types.StringNull()
	if issued.Mesh != nil {
		plan.MeshSetupKey = types.StringValue(issued.Mesh.SetupKey)
	}
	if issued.Install.Warning != nil {
		resp.Diagnostics.AddWarning("The install URL is not reachable from other servers", *issued.Install.Warning)
	}
	if !plan.MaxUses.IsUnknown() && plan.MaxUses.ValueInt64() != issued.MaxUses {
		resp.Diagnostics.AddWarning("Join token is single-use",
			"The org runs a mesh, so the controller made this token single-use; max_uses is kept as configured in state.")
	} else {
		plan.MaxUses = types.Int64Value(issued.MaxUses)
	}

	// The create answers the token once; the list carries the rest.
	tok, err := r.client.GetJoinToken(ctx, issued.ID)
	if err != nil {
		resp.Diagnostics.AddError("Error reading join token after create", err.Error())
		return
	}
	r.mapToState(tok, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *joinTokenResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state joinTokenModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	tok, err := r.client.GetJoinToken(ctx, state.ID.ValueString())
	if err != nil {
		if client.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Error reading join token", err.Error())
		return
	}
	// A revoked token enrolls nothing: treat it as gone so the next apply
	// mints a new one.
	if tok.Status == "revoked" {
		resp.State.RemoveResource(ctx)
		return
	}
	r.mapToState(tok, &state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

// Update only carries state: every argument forces a new token.
func (r *joinTokenResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var state joinTokenModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *joinTokenResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state joinTokenModel
	resp.Diagnostics.Append(req.State.Get(ctx, &state)...)
	if resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.RevokeJoinToken(ctx, state.ID.ValueString()); err != nil {
		if client.IsNotFound(err) {
			return
		}
		resp.Diagnostics.AddError("Error revoking join token", err.Error())
	}
}

// ImportState adopts a token by ID. Its plaintext, mesh key and install URL
// are not recoverable, so they stay null.
func (r *joinTokenResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}

// mapToState copies the listed fields. The arguments are immutable on the
// controller, so they are only filled when state has none (after import).
func (r *joinTokenResource) mapToState(t *client.JoinToken, m *joinTokenModel) {
	m.ID = types.StringValue(t.ID)
	m.TokenPrefix = types.StringValue(t.TokenPrefix)
	m.CreatedAt = types.StringValue(t.CreatedAt)
	m.ExpiresAt = stringPtrToValue(t.ExpiresAt)
	m.UsedCount = types.Int64Value(t.UsedCount)
	m.Status = types.StringValue(t.Status)
	if m.Label.IsNull() || m.Label.IsUnknown() {
		m.Label = stringPtrToValue(t.Label)
	}
	if m.Profile.IsNull() || m.Profile.IsUnknown() {
		m.Profile = stringPtrToValue(t.Profile)
	}
	if (m.MaxUses.IsNull() || m.MaxUses.IsUnknown()) && t.MaxUses != nil {
		m.MaxUses = types.Int64Value(*t.MaxUses)
	}
	if m.TTLSeconds.IsNull() || m.TTLSeconds.IsUnknown() {
		m.TTLSeconds = ttlOf(t)
	}
	if m.Token.IsUnknown() {
		m.Token = types.StringNull()
	}
	if m.MeshSetupKey.IsUnknown() {
		m.MeshSetupKey = types.StringNull()
	}
	if m.InstallURL.IsUnknown() {
		m.InstallURL = types.StringNull()
	}
}

// ttlOf derives the lifetime from created_at → expires_at (whole seconds).
func ttlOf(t *client.JoinToken) types.Int64 {
	if t.ExpiresAt == nil {
		return types.Int64Null()
	}
	created, err1 := time.Parse(time.RFC3339Nano, t.CreatedAt)
	expires, err2 := time.Parse(time.RFC3339Nano, *t.ExpiresAt)
	if err1 != nil || err2 != nil {
		return types.Int64Null()
	}
	return types.Int64Value(int64(math.Round(expires.Sub(created).Seconds())))
}
