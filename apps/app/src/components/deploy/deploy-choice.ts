/** What the Deploy hub has picked: a template, or one of the bring-your-own routes. */
export type DeployChoice =
  | { kind: 'template'; id: string }
  | { kind: 'git' }
  | { kind: 'compose' }
  | { kind: 'image' };

export type OwnKind = Exclude<DeployChoice['kind'], 'template'>;

export interface OwnOption {
  kind: OwnKind;
  title: string;
  /** Plain line (Summary). */
  say: string;
  /** What swarmy generates from it (Controls). */
  tech: string;
  /** The step that takes it from here. */
  to: '/ci' | '/stacks/new' | '/services/new';
  cta: string;
}

export const OWN_OPTIONS: OwnOption[] = [
  {
    kind: 'git',
    title: 'Git repo',
    say: 'built on every push',
    tech: 'reads swarmy.yaml, a compose file or a Dockerfile · builds on your servers · pushes to the in-swarm registry',
    to: '/ci',
    cta: 'Connect a repo',
  },
  {
    kind: 'compose',
    title: 'Compose file',
    say: 'paste it in',
    tech: 'docker compose → one swarm stack · every service at once · .env substitution',
    to: '/stacks/new',
    cta: 'Paste a compose file',
  },
  {
    kind: 'image',
    title: 'Image',
    say: 'from any registry',
    tech: 'one image → one service · copies, ports, env, optional web address',
    to: '/services/new',
    cta: 'Pick an image',
  },
];
