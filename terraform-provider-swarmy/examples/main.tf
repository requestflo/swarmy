# Example swarmy Terraform configuration (Phase 3 target — provider not yet built).
# See ../README.md for the provider plan and how the spec/SDK/provider fit together.

terraform {
  required_providers {
    swarmy = {
      source  = "swarmy-dev/swarmy"
      version = "~> 0.1"
    }
  }
}

provider "swarmy" {
  endpoint = "https://controller.example.com"
  # api_key sourced from the SWARMY_API_KEY env var (mint in Settings → API keys)
}

# Look up an existing node (nodes self-register via the agent + a join token).
data "swarmy_node" "first" {
  name = "prod-worker-1"
}

# Manage a service declaratively. Create/update dispatch an async deploy; the
# provider blocks until the deployment reaches a terminal phase.
resource "swarmy_service" "web" {
  name     = "web"
  image    = "nginx:1.27"
  replicas = 3
  node_id  = data.swarmy_node.first.id

  env = {
    LOG_LEVEL = "info"
  }
}

# Route a domain at the service via the ingress driver.
resource "swarmy_ingress_domain" "web" {
  host        = "app.example.com"
  service_id  = swarmy_service.web.id
  target_port = 80
  tls         = "auto"
}
