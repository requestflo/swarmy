package client

import (
	"context"
	"net/http"
	"net/url"
)

// ---- Alert rules (/alert-rules) and notification channels (/notification-channels) ----

// AlertSelector mirrors the AlertSelector DTO: what a rule is narrowed to.
type AlertSelector struct {
	App     string `json:"app,omitempty"`
	Server  string `json:"server,omitempty"`
	Service string `json:"service,omitempty"`
}

// AlertRule mirrors the AlertRule DTO.
type AlertRule struct {
	ID         string        `json:"id"`
	Name       string        `json:"name"`
	Signal     string        `json:"signal"`
	Selector   AlertSelector `json:"selector"`
	Threshold  *float64      `json:"threshold"`
	ForSeconds int64         `json:"for_seconds"`
	ChannelIDs []string      `json:"channel_ids"`
	Enabled    bool          `json:"enabled"`
	IsDefault  bool          `json:"is_default"`
	MutedUntil *string       `json:"muted_until"`
	CreatedAt  string        `json:"created_at"`
}

// AlertRuleWrite is the create (POST) and update (PATCH) body. Every field is
// sent, so the configuration is the whole truth: a nil Threshold is null
// (none), an empty Selector is "any subject". Signal is create-only.
type AlertRuleWrite struct {
	Name       string        `json:"name"`
	Signal     string        `json:"signal,omitempty"`
	Selector   AlertSelector `json:"selector"`
	Threshold  *float64      `json:"threshold"`
	ForSeconds int64         `json:"for_seconds"`
	ChannelIDs []string      `json:"channel_ids"`
	Enabled    bool          `json:"enabled"`
}

// CreateAlertRule adds a rule (201).
func (c *Client) CreateAlertRule(ctx context.Context, body AlertRuleWrite) (*AlertRule, error) {
	if body.ChannelIDs == nil {
		body.ChannelIDs = []string{}
	}
	var out AlertRule
	if err := c.post(ctx, "/alert-rules", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetAlertRule reads one rule; an unknown (or opted-out default) id is a 404.
func (c *Client) GetAlertRule(ctx context.Context, id string) (*AlertRule, error) {
	var out AlertRule
	if err := c.get(ctx, "/alert-rules/"+url.PathEscape(id), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateAlertRule rewrites a rule in place (the signal never changes).
func (c *Client) UpdateAlertRule(ctx context.Context, id string, body AlertRuleWrite) (*AlertRule, error) {
	body.Signal = ""
	if body.ChannelIDs == nil {
		body.ChannelIDs = []string{}
	}
	var out AlertRule
	if err := c.do(ctx, http.MethodPatch, "/alert-rules/"+url.PathEscape(id), body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteAlertRule removes a rule (a seeded default is opted out instead).
func (c *Client) DeleteAlertRule(ctx context.Context, id string) error {
	return c.delete(ctx, "/alert-rules/"+url.PathEscape(id), nil)
}

// NotificationChannel mirrors the NotificationChannel DTO (the destination is
// never returned; Target is a redacted host or address).
type NotificationChannel struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Enabled   bool   `json:"enabled"`
	Target    string `json:"target"`
	HasSecret bool   `json:"has_secret"`
	CreatedAt string `json:"created_at"`
}

// NotificationChannelConfig is the write-only destination.
type NotificationChannelConfig struct {
	Kind     string `json:"kind"`
	To       string `json:"to,omitempty"`
	URL      string `json:"url,omitempty"`
	Secret   string `json:"secret,omitempty"`
	BotToken string `json:"bot_token,omitempty"`
	ChatID   string `json:"chat_id,omitempty"`
	ThreadID int64  `json:"thread_id,omitempty"`
	Server   string `json:"server,omitempty"`
	Topic    string `json:"topic,omitempty"`
	Token    string `json:"token,omitempty"`
}

// NotificationChannelWrite is the create/update body. On update a nil Config
// keeps the stored destination and a nil Enabled keeps the state.
type NotificationChannelWrite struct {
	Name    string                     `json:"name,omitempty"`
	Enabled *bool                      `json:"enabled,omitempty"`
	Config  *NotificationChannelConfig `json:"config,omitempty"`
}

// CreateNotificationChannel adds a channel (201); it starts enabled.
func (c *Client) CreateNotificationChannel(ctx context.Context, name string, cfg NotificationChannelConfig) (*NotificationChannel, error) {
	var out NotificationChannel
	body := NotificationChannelWrite{Name: name, Config: &cfg}
	if err := c.post(ctx, "/notification-channels", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetNotificationChannel reads one channel.
func (c *Client) GetNotificationChannel(ctx context.Context, id string) (*NotificationChannel, error) {
	var out NotificationChannel
	if err := c.get(ctx, "/notification-channels/"+url.PathEscape(id), &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateNotificationChannel renames, enables/disables or repoints a channel.
func (c *Client) UpdateNotificationChannel(ctx context.Context, id string, body NotificationChannelWrite) (*NotificationChannel, error) {
	var out NotificationChannel
	if err := c.do(ctx, http.MethodPatch, "/notification-channels/"+url.PathEscape(id), body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteNotificationChannel removes a channel.
func (c *Client) DeleteNotificationChannel(ctx context.Context, id string) error {
	return c.delete(ctx, "/notification-channels/"+url.PathEscape(id), nil)
}
