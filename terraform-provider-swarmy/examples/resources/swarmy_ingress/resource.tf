# The org's edge settings: one swarmy_ingress per org (the API key's org;
# the key's creator must be an admin or owner). The configuration is the
# whole truth — anything left unset goes to its default — and every apply is
# one write after which the edge converges once.
#
# Destroying this resource does NOT remove the edge: it puts every setting
# back to its default (swarmy's Caddy, enabled, the replicated controller,
# the default image, no pin, no ACME email, no on-demand TLS, no tunnel, no
# DNS provider). Leaving edge-per-node that way removes and recreates the
# edge service (seconds of downtime on 80/443).

variable "cloudflare_dns_token" {
  type      = string
  sensitive = true
}

resource "swarmy_ingress" "edge" {
  driver  = "caddy"
  enabled = true

  # A Caddy on every ingress-labelled node (needs swarmy object storage).
  topology = "edge-per-node"

  acme_email        = "ops@example.com"
  on_demand_tls     = true
  on_demand_ask_url = "https://controller.example.com/ingress/ask"

  # Wildcard certificates for zones swarmy DNS does not serve. The token is
  # write-only: it goes into a Docker secret and is never read back.
  dns_provider = {
    provider  = "cloudflare"
    api_token = var.cloudflare_dns_token
  }

  # Or, with driver = "cloudflared", serve through a Cloudflare Tunnel:
  # tunnel = {
  #   run_token = var.cloudflare_tunnel_token
  #   replicas  = 2
  # }
}

# Adopt the org's current settings (the ID is the org id):
#   terraform import swarmy_ingress.edge <org_id>
