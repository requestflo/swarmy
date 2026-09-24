# Token-based connections only. GitHub App and GitLab OAuth connections need a
# browser round-trip — connect those in the dashboard (Settings → Git).
resource "swarmy_git_connection" "gitlab" {
  kind  = "gitlab"
  token = var.gitlab_token # personal/project/group access token; sensitive, write-only
  # base_url = "https://gitlab.example.com" # self-managed GitLab (default https://gitlab.com)
}

resource "swarmy_git_connection" "gitea" {
  kind         = "gitea" # or "generic"
  base_url     = "https://git.example.com"
  display_name = "Team Gitea"
  token        = var.gitea_token
  token_user   = "swarmy-bot"
}

# Import an existing connection by ID (the token is never read back):
#   terraform import swarmy_git_connection.gitlab gc-abc123
