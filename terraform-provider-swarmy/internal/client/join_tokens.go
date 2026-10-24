package client

import (
	"context"
	"fmt"
	"net/url"
)

// ---- Join tokens (/join-tokens) ----
//
// A join token enrolls new servers (the agent installer's SWARMY_JOIN_TOKEN).
// The plaintext is returned once, by the create; the list never carries it.

// JoinToken mirrors the JoinToken DTO (GET /join-tokens).
type JoinToken struct {
	ID          string  `json:"id"`
	Label       *string `json:"label"`
	Profile     *string `json:"profile"`
	TokenPrefix string  `json:"token_prefix"`
	CreatedAt   string  `json:"created_at"`
	ExpiresAt   *string `json:"expires_at"`
	MaxUses     *int64  `json:"max_uses"`
	UsedCount   int64   `json:"used_count"`
	RevokedAt   *string `json:"revoked_at"`
	// Status is active, expired, exhausted or revoked (open set).
	Status string `json:"status"`
}

// JoinTokenMesh is the mesh setup key a node joins the mesh with first, set
// when the org runs a mesh.
type JoinTokenMesh struct {
	SetupKey      string  `json:"setup_key"`
	ManagementURL *string `json:"management_url"`
	Driver        *string `json:"driver"`
}

// JoinTokenInstall is the controller URL the install one-liner should use.
type JoinTokenInstall struct {
	URL      string  `json:"url"`
	Loopback bool    `json:"loopback"`
	Warning  *string `json:"warning"`
}

// JoinTokenIssued mirrors the JoinTokenIssued DTO (POST /join-tokens, 201).
type JoinTokenIssued struct {
	ID        string           `json:"id"`
	Token     string           `json:"token"`
	Label     *string          `json:"label"`
	Profile   *string          `json:"profile"`
	ExpiresAt string           `json:"expires_at"`
	MaxUses   int64            `json:"max_uses"`
	Mesh      *JoinTokenMesh   `json:"mesh"`
	Install   JoinTokenInstall `json:"install"`
}

// CreateJoinTokenRequest is the body for POST /join-tokens.
type CreateJoinTokenRequest struct {
	Label      *string `json:"label,omitempty"`
	TTLSeconds *int64  `json:"ttl_seconds,omitempty"`
	MaxUses    *int64  `json:"max_uses,omitempty"`
	Profile    *string `json:"profile,omitempty"`
}

// CreateJoinToken mints a join token (admins and owners). The plaintext is in
// the response's Token, and only there.
func (c *Client) CreateJoinToken(ctx context.Context, body CreateJoinTokenRequest) (*JoinTokenIssued, error) {
	var out JoinTokenIssued
	if err := c.post(ctx, "/join-tokens", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListJoinTokens returns the org's join tokens, newest first (revoked ones
// included).
func (c *Client) ListJoinTokens(ctx context.Context) ([]JoinToken, error) {
	var env listEnvelope[JoinToken]
	if err := c.get(ctx, "/join-tokens", &env); err != nil {
		return nil, err
	}
	return env.Data, nil
}

// GetJoinToken reads one join token by ID. There is no per-token read, so
// this filters the list; an unknown ID is a 404 APIError.
func (c *Client) GetJoinToken(ctx context.Context, id string) (*JoinToken, error) {
	tokens, err := c.ListJoinTokens(ctx)
	if err != nil {
		return nil, err
	}
	for i := range tokens {
		if tokens[i].ID == id {
			return &tokens[i], nil
		}
	}
	return nil, &APIError{StatusCode: 404, RawBody: fmt.Sprintf("join token %q not found", id)}
}

// RevokeJoinToken revokes a join token (DELETE /join-tokens/{id}).
func (c *Client) RevokeJoinToken(ctx context.Context, id string) error {
	return c.delete(ctx, "/join-tokens/"+url.PathEscape(id), nil)
}
