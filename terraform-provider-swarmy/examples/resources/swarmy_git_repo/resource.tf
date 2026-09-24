# A repo picked from the connection's listing (GET /git/connections/{id}/repos).
resource "swarmy_git_repo" "web" {
  connection_id = swarmy_git_connection.gitlab.id
  repo_id       = "4242"
  full_name     = "acme/web"
  clone_url     = "https://gitlab.com/acme/web.git"
  branch        = "main"        # updated in place
  config_path   = "swarmy.yaml" # updated in place

  # Every planned step waits for confirmation in the dashboard.
  require_approval = true
  # Re-apply drift on git-owned fields (default: report only).
  enforce_drift = true
}

# A generic SSH remote with a swarmy-minted deploy key.
resource "swarmy_git_repo" "infra" {
  url         = "git@git.example.com:acme/infra.git"
  branch      = "main"
  config_path = "deploy/swarmy.yaml"
  deploy_key  = true
}

# Returned once on create: paste these into the git host.
output "infra_deploy_key" {
  value = swarmy_git_repo.infra.deploy_key_public
}
output "infra_webhook" {
  value     = { url = swarmy_git_repo.infra.webhook_url, secret = swarmy_git_repo.infra.webhook_secret }
  sensitive = true
}

# Import by ID (write-once webhook secret / deploy key are null after import):
#   terraform import swarmy_git_repo.web gr-abc123
