# Realistic end-to-end swarmy Terraform configuration.
#
# Build & install the provider locally first:
#   make install
# then `terraform init` here will find it via the local plugin mirror.

terraform {
  required_providers {
    swarmy = {
      source  = "registry.terraform.io/requestflo/swarmy"
      version = "~> 0.1"
    }
  }
}

provider "swarmy" {
  endpoint = "https://controller.example.com" # or SWARMY_ENDPOINT
  # api_key sourced from the SWARMY_API_KEY env var (mint in Settings -> API keys)
}

# Look up an existing node (nodes self-register via the agent + a join token).
data "swarmy_node" "first" {
  name = "prod-worker-1"
}

# Manage a service declaratively. Create/update dispatch an async deploy; the
# provider reads the service back to populate computed fields (id, status).
resource "swarmy_service" "web" {
  name     = "web"
  image    = "nginx:1.27"
  replicas = 3
  node_id  = data.swarmy_node.first.id

  command = ["nginx", "-g", "daemon off;"]

  env = {
    LOG_LEVEL = "info"
  }
}

# Deploy a compose-style stack.
resource "swarmy_stack" "platform" {
  name           = "platform"
  compose_source = file("${path.module}/compose.yaml")
}

# Route a domain at the service via the ingress driver.
resource "swarmy_domain" "web" {
  host        = "app.example.com"
  service_id  = swarmy_service.web.id
  target_port = 80
  tls         = "auto"
  path_prefix = "/"
}

# Mint a scoped API key. The token is sensitive and only returned on creation.
resource "swarmy_api_key" "ci" {
  name   = "ci-deployer"
  scopes = ["read", "write"]
}

output "ci_api_key_token" {
  value     = swarmy_api_key.ci.token
  sensitive = true
}
