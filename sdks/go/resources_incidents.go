package swarmy

import (
	"context"
	"net/url"
	"strconv"
)

// statusLimit builds the status/limit filter of the incident and event lists.
func statusLimit(status string, limit int) url.Values {
	v := url.Values{}
	if status != "" {
		v.Set("status", status)
	}
	if limit > 0 {
		v.Set("limit", strconv.Itoa(limit))
	}
	return v
}

// IncidentsService groups incidents (/incidents): read the story, resolve it.
type IncidentsService struct{ client *Client }

// List returns incidents, open first then newest. status is "open",
// "resolved" or "" (all); limit 0 means the default (50).
func (s *IncidentsService) List(ctx context.Context, status string, limit int) (*IncidentList, error) {
	var out IncidentList
	if err := s.client.do(ctx, "GET", "/incidents", statusLimit(status, limit), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Get returns one incident with its timeline (oldest event first).
func (s *IncidentsService) Get(ctx context.Context, id string) (*IncidentDetail, error) {
	var out IncidentDetail
	if err := s.client.do(ctx, "GET", "/incidents/"+pathEscape(id), nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Resolve resolves an open incident; message ("" = none) goes on its timeline.
func (s *IncidentsService) Resolve(ctx context.Context, id, message string) (*IncidentDetail, error) {
	var out IncidentDetail
	body := ResolveIncidentRequest{Message: message}
	if err := s.client.do(ctx, "POST", "/incidents/"+pathEscape(id)+"/resolve", nil, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// AlertEventsService groups alert events (/alert-events).
type AlertEventsService struct{ client *Client }

// List returns events, newest first. status is "firing", "resolved" or "" (all).
func (s *AlertEventsService) List(ctx context.Context, status string, limit int) (*AlertEventList, error) {
	var out AlertEventList
	if err := s.client.do(ctx, "GET", "/alert-events", statusLimit(status, limit), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Acknowledge manually resolves a firing event (no recovery notification).
func (s *AlertEventsService) Acknowledge(ctx context.Context, id string) (*AlertEvent, error) {
	var out AlertEvent
	if err := s.client.do(ctx, "POST", "/alert-events/"+pathEscape(id)+"/acknowledge", nil, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
