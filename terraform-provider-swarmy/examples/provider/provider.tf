provider "swarmy" {
  # Base URL of your swarmy controller. May also be set via SWARMY_ENDPOINT.
  endpoint = "https://controller.example.com"

  # swarmy API key (swk_...). Prefer the SWARMY_API_KEY env var over hardcoding.
  # api_key = var.swarmy_api_key
}
