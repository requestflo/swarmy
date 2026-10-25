package provider

import (
	"context"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/booldefault"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

var (
	_ resource.ResourceWithConfigure   = (*channelResource)(nil)
	_ resource.ResourceWithImportState = (*channelResource)(nil)
)

// channelResource manages swarmy_notification_channel over
// /notification-channels. The destination is write-only on the controller
// (stored encrypted, never returned), so it is kept from state and sent only
// on create or when it changes; `kind` forces a new channel.
type channelResource struct{ client *client.Client }

// NewNotificationChannelResource is the resource factory.
func NewNotificationChannelResource() resource.Resource { return &channelResource{} }

func (r *channelResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_notification_channel"
}

func (r *channelResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	c, err := clientFromProviderData(req.ProviderData)
	if err != nil {
		resp.Diagnostics.AddError("Unexpected provider data", err.Error())
		return
	}
	r.client = c
}

func (r *channelResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	keep := []planmodifier.String{stringplanmodifier.UseStateForUnknown()}
	dest := func(d string, sensitive bool) schema.StringAttribute {
		return schema.StringAttribute{Optional: true, Sensitive: sensitive, Description: d + " Write-only: never read back."}
	}
	resp.Schema = schema.Schema{
		Description: "A swarmy notification channel that alert rules send to. The destination arguments are write-only: " +
			"the controller stores them encrypted and never returns them, so they are kept from state (no drift detection) and " +
			"sent only on create or when they change. Destroying it runs the alert.remove policy step.",
		Attributes: map[string]schema.Attribute{
			"id":   schema.StringAttribute{Computed: true, Description: "Channel ID.", PlanModifiers: keep},
			"name": schema.StringAttribute{Required: true, Description: "What the channel is called."},
			"kind": schema.StringAttribute{
				Required:      true,
				Description:   "email, slack, teams, discord, telegram, ntfy, gotify or webhook. Changing it forces a new channel.",
				Validators:    []validator.String{stringvalidator.OneOf(channelKinds...)},
				PlanModifiers: []planmodifier.String{stringplanmodifier.RequiresReplace()},
			},
			"to":         dest("email: the address.", false),
			"url":        dest("slack, teams, discord, webhook: the incoming-webhook URL.", true),
			"secret":     dest("webhook: optional HMAC secret (8+ characters); deliveries are signed.", true),
			"bot_token":  dest("telegram: the BotFather token.", true),
			"chat_id":    dest("telegram: numeric chat id or @channel.", false),
			"thread_id":  schema.Int64Attribute{Optional: true, Description: "telegram: forum topic thread. Write-only."},
			"server":     dest("ntfy, gotify: the server URL.", false),
			"topic":      dest("ntfy: the topic.", false),
			"token":      dest("ntfy (optional), gotify: the access/app token.", true),
			"enabled":    schema.BoolAttribute{Optional: true, Computed: true, Default: booldefault.StaticBool(true), Description: "Defaults to true."},
			"target":     schema.StringAttribute{Computed: true, Description: "Redacted destination (an address or a host)."},
			"has_secret": schema.BoolAttribute{Computed: true, Description: "A signing secret or token is stored."},
			"created_at": schema.StringAttribute{Computed: true, Description: "When it was created (RFC 3339).", PlanModifiers: keep},
		},
	}
}

func (r *channelResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	var plan channelModel
	if resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...); resp.Diagnostics.HasError() {
		return
	}
	ch, err := r.client.CreateNotificationChannel(ctx, plan.Name.ValueString(), channelConfig(&plan))
	if err == nil && !plan.Enabled.ValueBool() {
		// New channels start enabled; switch it off as configured.
		ch, err = r.client.UpdateNotificationChannel(ctx, ch.ID, client.NotificationChannelWrite{Enabled: plan.Enabled.ValueBoolPointer()})
	}
	if err != nil {
		resp.Diagnostics.AddError("Error creating notification channel", err.Error())
		return
	}
	channelToState(ch, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *channelResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	var state channelModel
	if resp.Diagnostics.Append(req.State.Get(ctx, &state)...); resp.Diagnostics.HasError() {
		return
	}
	ch, err := r.client.GetNotificationChannel(ctx, state.ID.ValueString())
	if err != nil {
		if client.IsNotFound(err) {
			resp.State.RemoveResource(ctx)
			return
		}
		resp.Diagnostics.AddError("Error reading notification channel", err.Error())
		return
	}
	channelToState(ch, &state)
	resp.Diagnostics.Append(resp.State.Set(ctx, &state)...)
}

func (r *channelResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	var plan, state channelModel
	resp.Diagnostics.Append(req.Plan.Get(ctx, &plan)...)
	if resp.Diagnostics.Append(req.State.Get(ctx, &state)...); resp.Diagnostics.HasError() {
		return
	}
	body := client.NotificationChannelWrite{Name: plan.Name.ValueString(), Enabled: plan.Enabled.ValueBoolPointer()}
	if destinationChanged(&plan, &state) {
		cfg := channelConfig(&plan)
		body.Config = &cfg
	}
	ch, err := r.client.UpdateNotificationChannel(ctx, plan.ID.ValueString(), body)
	if err != nil {
		resp.Diagnostics.AddError("Error updating notification channel", err.Error())
		return
	}
	channelToState(ch, &plan)
	resp.Diagnostics.Append(resp.State.Set(ctx, &plan)...)
}

func (r *channelResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	var state channelModel
	if resp.Diagnostics.Append(req.State.Get(ctx, &state)...); resp.Diagnostics.HasError() {
		return
	}
	if err := r.client.DeleteNotificationChannel(ctx, state.ID.ValueString()); err != nil && !client.IsNotFound(err) {
		resp.Diagnostics.AddError("Error deleting notification channel", err.Error())
	}
}

// ImportState adopts a channel by ID. Its destination can't be read, so the
// destination arguments come back empty and the next apply writes them.
func (r *channelResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resource.ImportStatePassthroughID(ctx, path.Root("id"), req, resp)
}
