package client

// Models mirror the public REST DTOs (snake_case JSON) from
// packages/api-rest/src/dto.ts. Only fields present in those DTOs are mapped.

// EnvVar is a single environment variable in a service create request.
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

// ScaleServiceRequest is the body for POST /services/{id}/scale.
type ScaleServiceRequest struct {
	Replicas int64 `json:"replicas"`
}

// DeploymentRef is the 202 Accepted payload from async deploy endpoints.
type DeploymentRef struct {
	ID           string `json:"id"`
	DeploymentID string `json:"deployment_id"`
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

// APIKey mirrors the API key resource. NOTE: the public REST API does not yet
// expose an /api-keys endpoint in openapi.json; these shapes follow the
// documented convention (name + scopes in, token returned once on create). See
// README "Caveats".
type APIKey struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Scopes    []string `json:"scopes"`
	Token     string   `json:"token,omitempty"`
	CreatedAt string   `json:"created_at,omitempty"`
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
