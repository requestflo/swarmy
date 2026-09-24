data "swarmy_app" "web" {
  repo_id = swarmy_git_repo.web.id
}

output "web_production_plan" {
  value = one([for e in data.swarmy_app.web.environments : e.latest_plan_status if e.environment == "production"])
}

output "web_drifted_environments" {
  value = [for d in data.swarmy_app.web.drift : d.environment]
}
