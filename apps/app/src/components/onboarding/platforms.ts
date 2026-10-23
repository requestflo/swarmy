/**
 * Where the new server is (board 12's tabs). Every tab runs the same install
 * line; the clouds get it wrapped as cloud-config so the server joins on its
 * first boot. The join installer is fully non-interactive (env in, no TTY
 * reads) and runs as root, which is exactly what cloud-init's runcmd gives it.
 */
export type PlatformId = 'linux' | 'hetzner' | 'digitalocean' | 'pi' | 'nat';

export interface Platform {
  id: PlatformId;
  label: string;
  /** Paste as cloud-config (user data) instead of running the line by hand. */
  cloudConfig: boolean;
  hint: string;
}

export const PLATFORMS: Platform[] = [
  {
    id: 'linux',
    label: 'Any Linux',
    cloudConfig: false,
    hint: "Ubuntu, Debian, Fedora or Alpine, on 64-bit x86 or ARM. Run it as root. Docker is installed for you if it's missing.",
  },
  {
    id: 'hetzner',
    label: 'Hetzner',
    cloudConfig: true,
    hint: 'Paste this into Cloud config when you create the server. It joins on its first boot; you never SSH in.',
  },
  {
    id: 'digitalocean',
    label: 'DigitalOcean',
    cloudConfig: true,
    hint: 'When you create the Droplet, open Advanced options, add an initialization script and paste this. It joins on its first boot.',
  },
  {
    id: 'pi',
    label: 'Raspberry Pi',
    cloudConfig: false,
    hint: 'Any Pi on a 64-bit OS (Raspberry Pi OS 64-bit or Ubuntu Server); the ARM build is picked for you. 32-bit systems are refused.',
  },
  {
    id: 'nat',
    label: 'Home lab behind NAT',
    cloudConfig: false,
    hint: 'No public IP and no ports to forward: it dials out to swarmy over HTTPS.',
  },
];

export function platformOf(id: PlatformId): Platform {
  return PLATFORMS.find((p) => p.id === id) ?? PLATFORMS[0]!;
}

/** The install line as cloud-init user data: runcmd runs a string item with sh, as root. */
export function cloudConfig(line: string): string {
  return ['#cloud-config', '# joins swarmy on first boot', 'runcmd:', '  - |', `    ${line}`].join('\n');
}
