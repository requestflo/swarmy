import type { AppTemplate } from '../types';

// Not shipped (see the template authoring report):
//  - Excalidraw: the official image publishes only `latest` (its last versioned
//    tag is from 2021), so it can't be pinned to a current release.
//  - Penpot: the frontend's nginx serves uploaded assets straight from a
//    filesystem volume shared with the backend, which breaks when swarm places
//    the two on different nodes (templates have no co-location and no bucket
//    resource for S3 storage). The exporter also needs headless Chromium.

const ADMIN_EMAIL_OPTION = {
  key: 'admin_email',
  label: 'Admin email',
  kind: 'string' as const,
  help: 'The email you sign in with.',
  placeholder: 'you@example.com',
  defaultValue: 'admin@example.com',
};

export const DEVTOOLS_TEMPLATES: AppTemplate[] = [
  {
    id: 'gitea',
    name: 'Gitea',
    tagline: 'Lightweight self-hosted Git forge with issues, pull requests and CI',
    category: 'devtools',
    icon: 'gitea',
    website: 'https://about.gitea.com',
    version: '1.27.3',
    generate: { 'secret-key': { format: 'alnum', length: 64 } },
    notes: [
      'Git over SSH is not exposed (swarmy routes HTTP only), so clone and push over HTTPS with a password or access token.',
      'Open sign-up stays on until you turn it off; the first account registered becomes the site admin.',
    ],
    postDeploy: [
      'Open <url>/user/sign_up right away and register; the first account becomes the site admin.',
      'Close public sign-up: add env GITEA__service__DISABLE_REGISTRATION=true to the gitea service and redeploy.',
      'Create an access token (Settings → Applications) to push over HTTPS.',
    ],
    yaml: `version: 1
app: gitea
services:
  gitea:
    image: gitea/gitea:1.27.3
    port: 3000
    memory: 512mb
    env:
      GITEA__server__ROOT_URL: \${{ app.url }}/
      GITEA__server__DOMAIN: \${{ app.domain }}
      GITEA__server__DISABLE_SSH: "true"
      GITEA__database__DB_TYPE: postgres
      GITEA__database__HOST: \${{ db.host }}:\${{ db.port }}
      GITEA__database__NAME: \${{ db.database }}
      GITEA__database__USER: \${{ db.user }}
      GITEA__database__PASSWD: \${{ db.password }}
      GITEA__security__INSTALL_LOCK: "true"
      GITEA__security__SECRET_KEY__FILE: /run/secrets/secret-key
    secrets: [secret-key]
    volumes:
      data: /data
    healthcheck:
      path: /api/healthz
      interval: 30s
      timeout: 5s
      start_period: 60s
resources:
  db:
    type: postgres
    database: gitea
`,
  },
  {
    id: 'forgejo',
    name: 'Forgejo',
    tagline: 'Community-run Git forge with issues, pull requests and Actions',
    category: 'devtools',
    icon: 'forgejo',
    website: 'https://forgejo.org',
    version: '16.0.5',
    generate: { 'secret-key': { format: 'alnum', length: 64 } },
    notes: [
      'Git over SSH is not exposed (swarmy routes HTTP only), so clone and push over HTTPS with a password or access token.',
      'Open sign-up stays on until you turn it off; the first account registered becomes the site admin.',
    ],
    postDeploy: [
      'Open <url>/user/sign_up right away and register; the first account becomes the site admin.',
      'Close public sign-up: add env FORGEJO__service__DISABLE_REGISTRATION=true to the forgejo service and redeploy.',
      'Create an access token (Settings → Applications) to push over HTTPS.',
    ],
    yaml: `version: 1
app: forgejo
services:
  forgejo:
    image: codeberg.org/forgejo/forgejo:16.0.5
    port: 3000
    memory: 512mb
    env:
      FORGEJO__server__ROOT_URL: \${{ app.url }}/
      FORGEJO__server__DOMAIN: \${{ app.domain }}
      FORGEJO__server__DISABLE_SSH: "true"
      FORGEJO__database__DB_TYPE: postgres
      FORGEJO__database__HOST: \${{ db.host }}:\${{ db.port }}
      FORGEJO__database__NAME: \${{ db.database }}
      FORGEJO__database__USER: \${{ db.user }}
      FORGEJO__database__PASSWD: \${{ db.password }}
      FORGEJO__security__INSTALL_LOCK: "true"
      FORGEJO__security__SECRET_KEY__FILE: /run/secrets/secret-key
    secrets: [secret-key]
    volumes:
      data: /data
    healthcheck:
      path: /api/healthz
      interval: 30s
      timeout: 5s
      start_period: 60s
resources:
  db:
    type: postgres
    database: forgejo
`,
  },
  {
    id: 'code-server',
    name: 'code-server',
    tagline: 'VS Code in the browser, running on your own server',
    category: 'devtools',
    icon: 'coder',
    website: 'https://coder.com/docs/code-server',
    version: '4.138.0',
    generate: { password: { format: 'alnum', length: 24 } },
    reveal: ['code-server password: ${{ secrets.password }} (shown once, so save it now)'],
    heavyReason: 'VS Code and its extension host want about 1 GB of RAM',
    notes: ['Anyone with the password gets a shell in the container, so treat it like an SSH key.'],
    postDeploy: [
      'Open the URL and sign in with the password shown above.',
      'Your files and extensions live in /home/coder, which is kept on a volume.',
    ],
    yaml: `version: 1
app: code-server
services:
  code:
    image: codercom/code-server:4.138.0
    port: 8080
    memory: 1gb
    env:
      PASSWORD: \${{ secrets.password }}
    volumes:
      home: /home/coder
    healthcheck:
      path: /healthz
      interval: 30s
      timeout: 5s
      start_period: 30s
`,
  },
  {
    id: 'it-tools',
    name: 'IT-Tools',
    tagline: 'Handy offline tools for developers, from hashes to JWT and cron parsers',
    category: 'devtools',
    icon: 'lucide:wrench',
    website: 'https://it-tools.tech',
    version: '2024.10.22',
    notes: ['A static site with no accounts: anyone with the URL can use it.'],
    postDeploy: ['Open the URL and pick a tool; everything runs in your browser.'],
    yaml: `version: 1
app: it-tools
services:
  it-tools:
    image: corentinth/it-tools:2024.10.22-7ca5933
    port: 80
    memory: 64mb
    healthcheck:
      path: /
      interval: 30s
      timeout: 5s
      start_period: 10s
`,
  },
  {
    id: 'pocketbase',
    name: 'PocketBase',
    tagline: 'Open source backend in one file: database, auth, files and realtime API',
    category: 'devtools',
    icon: 'pocketbase',
    website: 'https://pocketbase.io',
    version: '0.40.4',
    options: [ADMIN_EMAIL_OPTION],
    generate: { 'admin-password': { format: 'alnum', length: 24 } },
    reveal: ['PocketBase superuser login: your admin email / ${{ secrets.admin-password }} (shown once, so save it now)'],
    notes: [
      'PocketBase has no official image; this uses the widely used community image ghcr.io/muchobien/pocketbase.',
      'The superuser password is reset to the generated one on every restart, so manage other admins in the dashboard.',
    ],
    postDeploy: [
      'Open <url>/_/ and sign in with your admin email and the password shown above.',
      'Create your collections; the API is served at <url>/api/.',
    ],
    yaml: `version: 1
app: pocketbase
services:
  pocketbase:
    image: ghcr.io/muchobien/pocketbase:0.40.4
    port: 8090
    memory: 128mb
    env:
      PB_ADMIN_EMAIL: "[[opt.admin_email]]"
      PB_ADMIN_PASSWORD: \${{ secrets.admin-password }}
    volumes:
      data: /pb_data
    healthcheck:
      path: /api/health
      interval: 30s
      timeout: 5s
      start_period: 15s
`,
  },
  {
    id: 'drawio',
    name: 'draw.io',
    tagline: 'Diagram editor for flowcharts, network maps and UML',
    category: 'devtools',
    icon: 'diagramsdotnet',
    website: 'https://www.drawio.com',
    version: '31.4.6',
    notes: ['Diagrams are saved in your browser or to your own device/cloud storage; the server keeps no files and has no accounts.'],
    postDeploy: ['Open the URL and choose where to save diagrams (Device is the simplest).'],
    yaml: `version: 1
app: drawio
services:
  drawio:
    image: jgraph/drawio:31.4.6
    port: 8080
    memory: 512mb
    healthcheck:
      path: /
      interval: 30s
      timeout: 5s
      start_period: 90s
`,
  },
  {
    id: 'cyberchef',
    name: 'CyberChef',
    tagline: 'The cyber Swiss Army knife for encoding, decoding and data analysis',
    category: 'devtools',
    icon: 'lucide:chef-hat',
    website: 'https://gchq.github.io/CyberChef',
    version: '11.5.0',
    notes: ['A static site with no accounts: anyone with the URL can use it. Data never leaves the browser.'],
    postDeploy: ['Open the URL and drag operations into the recipe.'],
    yaml: `version: 1
app: cyberchef
services:
  cyberchef:
    image: ghcr.io/gchq/cyberchef:11.5.0
    port: 8080
    memory: 64mb
    healthcheck:
      path: /
      interval: 30s
      timeout: 5s
      start_period: 10s
`,
  },
];
