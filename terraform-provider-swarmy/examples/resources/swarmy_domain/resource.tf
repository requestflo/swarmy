resource "swarmy_domain" "web" {
  host        = "app.example.com"
  service_id  = swarmy_service.web.id
  target_port = 80
  tls         = "auto" # one of: auto, off, custom
  path_prefix = "/"
}

# Import an existing ingress domain by ID:
#   terraform import swarmy_domain.web dom-abc123
