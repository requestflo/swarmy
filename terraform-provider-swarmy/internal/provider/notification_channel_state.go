package provider

import (
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/requestflo/terraform-provider-swarmy/internal/client"
)

// channelKinds are the kinds the controller delivers to.
var channelKinds = []string{"email", "slack", "teams", "discord", "telegram", "ntfy", "gotify", "webhook"}

type channelModel struct {
	ID        types.String `tfsdk:"id"`
	Name      types.String `tfsdk:"name"`
	Kind      types.String `tfsdk:"kind"`
	To        types.String `tfsdk:"to"`
	URL       types.String `tfsdk:"url"`
	Secret    types.String `tfsdk:"secret"`
	BotToken  types.String `tfsdk:"bot_token"`
	ChatID    types.String `tfsdk:"chat_id"`
	ThreadID  types.Int64  `tfsdk:"thread_id"`
	Server    types.String `tfsdk:"server"`
	Topic     types.String `tfsdk:"topic"`
	Token     types.String `tfsdk:"token"`
	Enabled   types.Bool   `tfsdk:"enabled"`
	Target    types.String `tfsdk:"target"`
	HasSecret types.Bool   `tfsdk:"has_secret"`
	CreatedAt types.String `tfsdk:"created_at"`
}

// channelConfig is the destination as planned (the API ignores the fields a
// kind doesn't take and refuses a destination the kind can't use).
func channelConfig(m *channelModel) client.NotificationChannelConfig {
	return client.NotificationChannelConfig{
		Kind:     m.Kind.ValueString(),
		To:       m.To.ValueString(),
		URL:      m.URL.ValueString(),
		Secret:   m.Secret.ValueString(),
		BotToken: m.BotToken.ValueString(),
		ChatID:   m.ChatID.ValueString(),
		ThreadID: m.ThreadID.ValueInt64(),
		Server:   m.Server.ValueString(),
		Topic:    m.Topic.ValueString(),
		Token:    m.Token.ValueString(),
	}
}

// destinationChanged reports whether any write-only destination argument
// differs between plan and state, i.e. whether an update must resend it.
func destinationChanged(plan, state *channelModel) bool {
	strs := [][2]types.String{
		{plan.To, state.To}, {plan.URL, state.URL}, {plan.Secret, state.Secret}, {plan.BotToken, state.BotToken},
		{plan.ChatID, state.ChatID}, {plan.Server, state.Server}, {plan.Topic, state.Topic}, {plan.Token, state.Token},
	}
	for _, p := range strs {
		if !p[0].Equal(p[1]) {
			return true
		}
	}
	return !plan.ThreadID.Equal(state.ThreadID)
}

// channelToState copies what the API returns; the destination stays as
// configured (it is never read back).
func channelToState(ch *client.NotificationChannel, m *channelModel) {
	m.ID = types.StringValue(ch.ID)
	m.Name = types.StringValue(ch.Name)
	m.Kind = types.StringValue(ch.Kind)
	m.Enabled = types.BoolValue(ch.Enabled)
	m.Target = types.StringValue(ch.Target)
	m.HasSecret = types.BoolValue(ch.HasSecret)
	m.CreatedAt = types.StringValue(ch.CreatedAt)
}
