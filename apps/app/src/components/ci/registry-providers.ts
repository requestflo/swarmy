/**
 * Provider presets for the registry-credentials form. UI hints ONLY — the
 * controller matches by `prefix`, never by provider.
 */
export type RegistryProvider = 'ghcr' | 'dockerhub' | 'gitlab' | 'ecr' | 'gcr' | 'acr' | 'generic';

export interface ProviderPreset {
  label: string;
  /** Pre-filled prefix (editable); '' when there's no single host. */
  prefix: string;
  prefixHint: string;
  usernameHint: string;
  secretHint: string;
}

export const PROVIDER_PRESETS: Record<RegistryProvider, ProviderPreset> = {
  ghcr: {
    label: 'GitHub (GHCR)',
    prefix: 'ghcr.io',
    prefixHint: 'ghcr.io or ghcr.io/<org> to scope it',
    usernameHint: 'GitHub username',
    secretHint: 'Personal access token with read:packages',
  },
  dockerhub: {
    label: 'Docker Hub',
    prefix: 'docker.io',
    prefixHint: 'docker.io (covers nginx, you/app, …)',
    usernameHint: 'Docker Hub username',
    secretHint: 'Access token (Account settings → Security)',
  },
  gitlab: {
    label: 'GitLab',
    prefix: 'registry.gitlab.com',
    prefixHint: 'registry.gitlab.com/<group> or your self-hosted registry host',
    usernameHint: 'Deploy-token username',
    secretHint: 'Deploy token with read_registry',
  },
  ecr: {
    label: 'AWS ECR',
    prefix: '',
    prefixHint: '<account>.dkr.ecr.<region>.amazonaws.com',
    usernameHint: 'AWS',
    secretHint: 'Output of `aws ecr get-login-password` — expires after 12h',
  },
  gcr: {
    label: 'Google Artifact Registry',
    prefix: '',
    prefixHint: '<region>-docker.pkg.dev/<project>',
    usernameHint: '_json_key',
    secretHint: 'Service-account JSON key (paste the whole file)',
  },
  acr: {
    label: 'Azure ACR',
    prefix: '',
    prefixHint: '<name>.azurecr.io',
    usernameHint: 'Service principal ID or token name',
    secretHint: 'Service principal secret or token password',
  },
  generic: {
    label: 'Other registry',
    prefix: '',
    prefixHint: 'registry.example.com[/path]',
    usernameHint: 'Username',
    secretHint: 'Password or token',
  },
};

export const PROVIDER_ORDER: RegistryProvider[] = ['ghcr', 'dockerhub', 'gitlab', 'ecr', 'gcr', 'acr', 'generic'];
