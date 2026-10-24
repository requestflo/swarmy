package client

// Models mirror the public REST DTOs (snake_case JSON) from
// packages/api-rest/src/dto.ts. Only fields present in those DTOs are mapped.

// EnvVar is a single environment variable in a service create/update request.
type EnvVar struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// Replicas is the desired/running replica counts on a Service.
type Replicas struct {
	Desired int64 `json:"desired"`
	Running int64 `json:"running"`
}

// Service mirrors the Service DTO returned by GET /services/{id}.
type Service struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Image          string   `json:"image"`
	Status         string   `json:"status"`
	Replicas       Replicas `json:"replicas"`
	IngressEnabled bool     `json:"ingress_enabled"`
	NodeID         *string  `json:"node_id"`
	StackID        *string  `json:"stack_id"`
	UpdatedAt      string   `json:"updated_at"`
	// LastError is the most recent task error Swarm reported (detail responses only).
	LastError *string `json:"last_error,omitempty"`
}

// CreateServiceRequest is the body for POST /services.
type CreateServiceRequest struct {
	Name     string   `json:"name"`
	Image    string   `json:"image"`
	Replicas *int64   `json:"replicas,omitempty"`
	Command  []string `json:"command,omitempty"`
	Env      []EnvVar `json:"env,omitempty"`
	NodeID   *string  `json:"node_id,omitempty"`
}

// UpdateServiceRequest is the body for PATCH /services/{id}. A nil field is
// left out, so the service keeps its live value. Command and Env are sent
// whole when set; an empty slice clears them (Env replaces the plain
// variables; secret variables set elsewhere are kept).
type UpdateServiceRequest struct {
	Image    *string   `json:"image,omitempty"`
	Replicas *int64    `json:"replicas,omitempty"`
	Command  *[]string `json:"command,omitempty"`
	Env      *[]EnvVar `json:"env,omitempty"`
}

// ScaleServiceRequest is the body for POST /services/{id}/scale.
type ScaleServiceRequest struct {
	Replicas int64 `json:"replicas"`
}

// DeploymentRef is the 202 Accepted payload from async deploy endpoints. Poll
// DeploymentID at GET /deployments/{id} until it reaches a terminal phase.
// Scale and restart answer an empty DeploymentID; the service ID (ID) polls
// the same convergence. DeployID is set for traced (stack) deploys.
type DeploymentRef struct {
	ID           string `json:"id"`
	DeploymentID string `json:"deployment_id"`
	DeployID     string `json:"deploy_id,omitempty"`
}

// DeploymentStatus mirrors the DeploymentStatus DTO returned by
// GET /deployments/{id} (declared in packages/api-rest/src/routes/devx.ts).
// Phase is an open set: queued, pulling, creating, converging, complete,
// failed, rolledback, canceled.
type DeploymentStatus struct {
	DeploymentID string  `json:"deployment_id"`
	ServiceID    *string `json:"service_id"`
	Kind         string  `json:"kind"`
	Phase        string  `json:"phase"`
	Desired      *int64  `json:"desired"`
	Ready        *int64  `json:"ready"`
	Message      *string `json:"message"`
	StartedAt    string  `json:"started_at"`
	FinishedAt   *string `json:"finished_at"`
}

// DeployEvent mirrors one DeployEvent of GET /deploys/{id}/events (declared in
// packages/api-rest/src/routes/deploys.ts). Only the fields the provider reads.
type DeployEvent struct {
	Seq     int64   `json:"seq"`
	At      int64   `json:"at"`
	Stage   string  `json:"stage"`
	Status  string  `json:"status"`
	Node    string  `json:"node"`
	Service *string `json:"service"`
	Message string  `json:"message"`
}

// DeployEvents mirrors the DeployEvents DTO: a traced deploy's events so far.
type DeployEvents struct {
	DeployID  string        `json:"deploy_id"`
	Stack     string        `json:"stack"`
	StartedAt int64         `json:"started_at"`
	Done      bool          `json:"done"`
	Data      []DeployEvent `json:"data"`
}

// Removed is the payload from a successful DELETE.
type Removed struct {
	ID      string `json:"id"`
	Removed bool   `json:"removed"`
}

// Stack mirrors the Stack DTO returned by GET /stacks/{id}.
type Stack struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	ServiceCount int64  `json:"service_count"`
	Status       string `json:"status"`
	UpdatedAt    string `json:"updated_at"`
}

// DeployStackRequest is the body for POST /stacks.
type DeployStackRequest struct {
	Name          string `json:"name"`
	ComposeSource string `json:"compose_source"`
}

// Domain mirrors the IngressDomain DTO returned by GET /ingress/domains.
type Domain struct {
	ID          string  `json:"id"`
	Host        string  `json:"host"`
	ServiceID   string  `json:"service_id"`
	ServiceName string  `json:"service_name"`
	TargetPort  int64   `json:"target_port"`
	TLS         string  `json:"tls"`
	PathPrefix  *string `json:"path_prefix"`
}

// AddDomainRequest is the body for POST /ingress/domains.
type AddDomainRequest struct {
	Host       string  `json:"host"`
	ServiceID  string  `json:"service_id"`
	TargetPort int64   `json:"target_port"`
	TLS        *string `json:"tls,omitempty"`
	PathPrefix *string `json:"path_prefix,omitempty"`
}

// Node mirrors the Node DTO returned by GET /nodes/{id}.
type Node struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Hostname      string  `json:"hostname"`
	Role          string  `json:"role"`
	Status        string  `json:"status"`
	EngineVersion *string `json:"engine_version"`
	OS            *string `json:"os"`
	Arch          *string `json:"arch"`
	LastSeenAt    *string `json:"last_seen_at"`
}

// NodeAvailability mirrors the NodeAvailability DTO (dto-extra.ts) returned by
// POST /nodes/{id}/drain, /cordon and /uncordon.
type NodeAvailability struct {
	ID           string `json:"id"`
	Availability string `json:"availability"`
}

// NodeLabels mirrors the NodeLabels DTO (dto-extra.ts) returned by
// PUT /nodes/{id}/labels.
type NodeLabels struct {
	ID     string            `json:"id"`
	Labels map[string]string `json:"labels"`
}

// SetNodeLabelsRequest is the body for PUT /nodes/{id}/labels. The controller
// merges these onto the swarm node's labels; it cannot delete a key.
type SetNodeLabelsRequest struct {
	Labels map[string]string `json:"labels"`
}

// APIKey mirrors the ApiKey DTO (GET /api-keys) and, on create, ApiKeyIssued
// (POST /api-keys), which adds the plaintext Key exactly once.
type APIKey struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Prefix    string   `json:"prefix"`
	Scopes    []string `json:"scopes"`
	Status    string   `json:"status"`
	ExpiresAt *string  `json:"expires_at"`
	CreatedAt string   `json:"created_at"`
	RevokedAt *string  `json:"revoked_at"`
	// Key is the plaintext swk_… key, set only in the create response.
	Key string `json:"key,omitempty"`
}

// CreateAPIKeyRequest is the body for POST /api-keys.
type CreateAPIKeyRequest struct {
	Name   string   `json:"name"`
	Scopes []string `json:"scopes"`
}

// listEnvelope is the cursor-pagination envelope wrapping list responses.
type listEnvelope[T any] struct {
	Data       []T     `json:"data"`
	NextCursor *string `json:"next_cursor"`
}
