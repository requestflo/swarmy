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
  {
    id: 'bullmq-worker',
    name: 'BullMQ worker',
    tagline: 'A sample job queue: an enqueue API and an autoscaled BullMQ worker on a managed queue',
    category: 'devtools',
    icon: 'lucide:list-ordered',
    website: 'https://docs.bullmq.io',
    version: '5.81.5',
    notes: [
      'A starting point, not a product: both services install bullmq@5.81.5 from npm when they start, so the swarm needs outbound internet. Replace them with your own images when you build a real worker.',
      'The queue is a managed Valkey that never evicts (maxmemory-policy noeviction), keeps an append-only log and is backed up nightly. Attach the worker in Messaging → Queues to autoscale it on backlog.',
    ],
    postDeploy: [
      'Open the URL: it shows the queue counts. POST /jobs with {"to":"you@example.com"} to enqueue a job, or leave demo load on.',
      'About one job in ten fails on purpose and retries with backoff. Open Messaging → Queues → Open studio to retry, promote, clean or pause.',
      'To scale the worker on backlog, attach it: Messaging → Queues → Attach worker (queue "emails", cache "jobs").',
    ],
    options: [
      {
        key: 'demo',
        label: 'Demo load',
        kind: 'boolean',
        help: 'Enqueue a sample job every 3 seconds so the studio has something to show.',
        defaultValue: true,
      },
    ],
    yaml: `version: 1
app: bullmq-worker
env:
  QUEUE_URL: \${{ jobs.url }}
  QUEUE_NAME: emails
  BULLMQ_CONNECT: |
    const fs = require('fs');
    const u = new URL(process.env.QUEUE_URL);
    const file = process.env.QUEUE_PASSWORD_FILE;
    const password = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : decodeURIComponent(u.password || '');
    module.exports = { host: u.hostname, port: Number(u.port || 6379), password: password || undefined, maxRetriesPerRequest: null };
services:
  api:
    image: node:22.20.0-alpine
    port: 3000
    memory: 192mb
    command: ["sh", "-c", "mkdir -p /srv && cd /srv && printf '%s' \\"$BULLMQ_CONNECT\\" > connect.js && printf '%s' \\"$API_JS\\" > api.js && npm i --no-save --no-audit --no-fund --silent bullmq@5.81.5 && exec node api.js"]
    env:
      DEMO_LOAD: "[[opt.demo]]"
      API_JS: |
        const http = require('http');
        const { Queue } = require('bullmq');
        const queue = new Queue(process.env.QUEUE_NAME, { connection: require('./connect.js') });
        const add = (to) => queue.add('send', { to, at: Date.now() }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 1000 });
        if (process.env.DEMO_LOAD === 'true') setInterval(() => add('demo-' + Math.floor(Math.random() * 1000) + '@example.com').catch(() => {}), 3000);
        http.createServer(async (req, res) => {
          try {
            if (req.url === '/healthz') return res.end('ok');
            if (req.method === 'POST' && req.url === '/jobs') {
              let body = '';
              for await (const c of req) body += c;
              const job = await add((JSON.parse(body || '{}').to) || 'someone@example.com');
              res.writeHead(201, { 'content-type': 'application/json' });
              return res.end(JSON.stringify({ id: job.id }));
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ queue: process.env.QUEUE_NAME, counts: await queue.getJobCounts() }, null, 2));
          } catch (e) {
            res.writeHead(500);
            res.end(String(e));
          }
        }).listen(3000);
    healthcheck:
      path: /healthz
      interval: 30s
      timeout: 5s
      start_period: 90s
  worker:
    image: node:22.20.0-alpine
    memory: 192mb
    command: ["sh", "-c", "mkdir -p /srv && cd /srv && printf '%s' \\"$BULLMQ_CONNECT\\" > connect.js && printf '%s' \\"$WORKER_JS\\" > worker.js && npm i --no-save --no-audit --no-fund --silent bullmq@5.81.5 && exec node worker.js"]
    env:
      WORKER_JS: |
        const fs = require('fs');
        const { Worker } = require('bullmq');
        const beat = () => fs.writeFileSync('/tmp/alive', String(Date.now()));
        beat();
        setInterval(beat, 5000);
        const worker = new Worker(process.env.QUEUE_NAME, async (job) => {
          await job.log('sending to ' + job.data.to);
          await job.updateProgress(50);
          await new Promise((r) => setTimeout(r, 200 + Math.random() * 600));
          if (Math.random() < 0.1) throw new Error('mailbox ' + job.data.to + ' is unreachable');
          await job.updateProgress(100);
          return { delivered: true };
        }, { connection: require('./connect.js'), concurrency: 5 });
        worker.on('failed', (job, err) => console.log('job', job && job.id, 'failed:', err.message));
        process.on('SIGTERM', async () => { await worker.close(); process.exit(0); });
    healthcheck:
      # No "$" (compose interpolation) and no "%s" (template placeholders): check the heartbeat in node (QA-047).
      command: ["node", "-e", "process.exit(Date.now() - require('fs').statSync('/tmp/alive').mtimeMs < 30000 ? 0 : 1)"]
      interval: 30s
      timeout: 5s
      start_period: 90s
resources:
  jobs:
    type: queue
    memory: 128mb
`,
  },
];
