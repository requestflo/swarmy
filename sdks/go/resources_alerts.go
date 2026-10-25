package swarmy

import "context"

// AlertRulesService groups alert rule operations (/alert-rules).
type AlertRulesService struct{ client *Client }

// List returns the org's alert rules (the per-signal defaults are seeded on first call).
func (s *AlertRulesService) List(ctx context.Context) (*AlertRuleList, error) {
	var out AlertRuleList
	if err := s.client.do(ctx, "GET", "/alert-rules", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get returns one alert rule.
func (s *AlertRulesService) Get(ctx context.Context, id string) (*AlertRule, error) {
	var out AlertRule
	if err := s.client.do(ctx, "GET", "/alert-rules/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Create adds a rule for a signal, optionally narrowed to one app/part or server (201).
func (s *AlertRulesService) Create(ctx context.Context, body CreateAlertRuleRequest) (*AlertRule, error) {
	var out AlertRule
	if err := s.client.do(ctx, "POST", "/alert-rules", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Update changes the fields set in body; the rest keep their value.
func (s *AlertRulesService) Update(ctx context.Context, id string, body UpdateAlertRuleRequest) (*AlertRule, error) {
	var out AlertRule
	if err := s.client.do(ctx, "PATCH", "/alert-rules/"+pathEscape(id), nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete removes a rule; a seeded default is opted out and never re-created.
func (s *AlertRulesService) Delete(ctx context.Context, id string) (*Removed, error) {
	var out Removed
	if err := s.client.do(ctx, "DELETE", "/alert-rules/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// NotificationChannelsService groups notification channel operations
// (/notification-channels). Destinations are write-only: never returned.
type NotificationChannelsService struct{ client *Client }

// List returns the org's channels (redacted targets only).
func (s *NotificationChannelsService) List(ctx context.Context) (*NotificationChannelList, error) {
	var out NotificationChannelList
	if err := s.client.do(ctx, "GET", "/notification-channels", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get returns one channel.
func (s *NotificationChannelsService) Get(ctx context.Context, id string) (*NotificationChannel, error) {
	var out NotificationChannel
	if err := s.client.do(ctx, "GET", "/notification-channels/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Create adds a channel (201); it starts enabled.
func (s *NotificationChannelsService) Create(ctx context.Context, body CreateNotificationChannelRequest) (*NotificationChannel, error) {
	var out NotificationChannel
	if err := s.client.do(ctx, "POST", "/notification-channels", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Update renames, enables/disables or repoints a channel (same kind only).
func (s *NotificationChannelsService) Update(ctx context.Context, id string, body UpdateNotificationChannelRequest) (*NotificationChannel, error) {
	var out NotificationChannel
	if err := s.client.do(ctx, "PATCH", "/notification-channels/"+pathEscape(id), nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete removes a channel.
func (s *NotificationChannelsService) Delete(ctx context.Context, id string) (*Removed, error) {
	var out Removed
	if err := s.client.do(ctx, "DELETE", "/notification-channels/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
