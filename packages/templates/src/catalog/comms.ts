import type { AppTemplate } from '../types';

export const COMMS_TEMPLATES: AppTemplate[] = [
  {
    id: 'mattermost',
    name: 'Mattermost',
    tagline: 'Self-hosted team chat with channels, threads and integrations',
    category: 'comms',
    icon: 'mattermost',
    website: 'https://mattermost.com',
    version: '11.11.1',
    imageHealthcheck: ['mattermost'],
    heavyReason: 'Mattermost wants about 1 GB of RAM on top of its Postgres database',
    postDeploy: [
      'Open <url> and create the first account: it becomes the system admin.',
      'Set up email under System Console → Environment → SMTP so invites, password resets and notifications send.',
    ],
    notes: ['This is the free Team Edition. Messages and users live in the managed Postgres database; uploaded files live on the data volume.'],
    yaml: `version: 1
app: mattermost
services:
  mattermost:
    image: mattermost/mattermost-team-edition:11.11.1
    port: 8065
    memory: 1gb
    env:
      MM_SQLSETTINGS_DRIVERNAME: postgres
      MM_SQLSETTINGS_DATASOURCE: "\${{ db.url }}?sslmode=disable&connect_timeout=10"
      MM_SERVICESETTINGS_SITEURL: \${{ app.url }}
      MM_SERVICESETTINGS_ENABLELOCALMODE: "true"
    volumes:
      config: /mattermost/config
      data: /mattermost/data
      logs: /mattermost/logs
      plugins: /mattermost/plugins
      client-plugins: /mattermost/client/plugins
resources:
  db:
    type: postgres
    database: mattermost
`,
  },
  {
    id: 'rocketchat',
    name: 'Rocket.Chat',
    tagline: 'Open-source team chat with omnichannel customer messaging',
    category: 'comms',
    icon: 'rocketdotchat',
    website: 'https://rocket.chat',
    version: '8.8.1',
    generate: { 'admin-password': { format: 'alnum', length: 24 } },
    reveal: ['Rocket.Chat admin login: admin / ${{ secrets.admin-password }} (shown once, so save it now)'],
    heavyReason: 'Rocket.Chat plus its MongoDB replica set want about 1.5 GB of RAM',
    postDeploy: [
      'Sign in at <url> as admin with the password shown above (the setup wizard is skipped).',
      'Change the admin email under your profile, then invite users under Administration → Users.',
      'Register the workspace under Administration → Workspace if you want mobile push notifications.',
    ],
    notes: [
      'Rocket.Chat needs MongoDB running as a replica set, so it runs its own single-node MongoDB (swarmy has no managed MongoDB). That database, which also holds uploaded files, is not in swarmy backups; back up the mongodb volume.',
      'The MongoDB healthcheck initiates the replica set on first start, so Rocket.Chat restarts a few times until MongoDB is ready. This is expected.',
      'Community edition limits apply; see rocket.chat/pricing.',
    ],
    yaml: `version: 1
app: rocketchat
services:
  rocketchat:
    image: rocketchat/rocket.chat:8.8.1
    port: 3000
    memory: 1gb
    env:
      ROOT_URL: \${{ app.url }}
      PORT: "3000"
      MONGO_URL: mongodb://mongodb:27017/rocketchat?replicaSet=rs0
      DEPLOY_METHOD: docker
      ADMIN_USERNAME: admin
      ADMIN_NAME: Admin
      ADMIN_EMAIL: admin@example.com
      ADMIN_PASS: \${{ secrets.admin-password }}
      OVERWRITE_SETTING_Show_Setup_Wizard: completed
    healthcheck:
      path: /api/info
      interval: 30s
      timeout: 10s
      start_period: 300s
  mongodb:
    image: mongo:8.2.12
    command: ["--replSet", "rs0", "--bind_ip_all", "--wiredTigerCacheSizeGB", "0.25"]
    memory: 512mb
    volumes:
      mongodb: /data/db
    healthcheck:
      command: ["mongosh", "--quiet", "--eval", "try { rs.status() } catch (e) { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongodb:27017' }] }) }"]
      interval: 15s
      timeout: 10s
      start_period: 30s
`,
  },
  {
    id: 'ntfy',
    name: 'ntfy',
    tagline: 'Send push notifications to your phone or desktop with a simple HTTP call',
    category: 'comms',
    icon: 'ntfy',
    website: 'https://ntfy.sh',
    version: '2.28.0',
    postDeploy: [
      'Open a terminal in the ntfy service and run ntfy user add --role=admin admin to create your login (anonymous access is off).',
      'Subscribe to a topic at <url> or in the ntfy phone app (add <url> as a server), then publish with curl -u admin:PASSWORD -d "hello" <url>/mytopic.',
    ],
    notes: [
      'Anonymous access is set to deny-all, so every publish and subscribe needs a user or access token. Change NTFY_AUTH_DEFAULT_ACCESS if you want public topics.',
      'This server talks to no third party. iOS instant notifications are opt-in: set NTFY_UPSTREAM_BASE_URL=https://ntfy.sh on the ntfy service to forward a poll request (no message content) to ntfy.sh, which relays it to Apple push.',
    ],
    yaml: `version: 1
app: ntfy
services:
  ntfy:
    image: binwiederhier/ntfy:v2.28.0
    command: ["serve"]
    port: 80
    memory: 128mb
    env:
      NTFY_BASE_URL: \${{ app.url }}
      NTFY_BEHIND_PROXY: "true"
      NTFY_DATABASE_URL: "\${{ db.url }}?sslmode=disable"
      NTFY_AUTH_DEFAULT_ACCESS: deny-all
      NTFY_ENABLE_LOGIN: "true"
      NTFY_ATTACHMENT_CACHE_DIR: /var/lib/ntfy/attachments
    volumes:
      data: /var/lib/ntfy
    healthcheck:
      path: /v1/health
      interval: 30s
      timeout: 5s
      start_period: 30s
resources:
  db:
    type: postgres
    database: ntfy
`,
  },
  {
    id: 'gotify',
    name: 'Gotify',
    tagline: 'Simple self-hosted server for sending and receiving push messages',
    category: 'comms',
    icon: 'lucide:bell-ring',
    website: 'https://gotify.net',
    version: '3.1.1',
    generate: { 'admin-password': { format: 'alnum', length: 24 } },
    reveal: ['Gotify admin login: admin / ${{ secrets.admin-password }} (shown once, so save it now)'],
    imageHealthcheck: ['gotify'],
    postDeploy: [
      'Sign in at <url> as admin with the password shown above.',
      'Create an application under Apps to get a token, then send with curl "<url>/message?token=TOKEN" -F "title=Hi" -F "message=Hello".',
      'Install the Gotify Android app (or a desktop client) and log in to receive messages.',
    ],
    yaml: `version: 1
app: gotify
services:
  gotify:
    image: gotify/server:3.1.1
    port: 80
    memory: 128mb
    env:
      GOTIFY_DEFAULTUSER_NAME: admin
      GOTIFY_DEFAULTUSER_PASS: \${{ secrets.admin-password }}
      GOTIFY_DATABASE_DIALECT: postgres
      GOTIFY_DATABASE_CONNECTION: "host=\${{ db.host }} port=\${{ db.port }} user=\${{ db.user }} dbname=\${{ db.database }} password=\${{ db.password }} sslmode=disable"
    volumes:
      data: /app/data
resources:
  db:
    type: postgres
    database: gotify
`,
  },
  {
    id: 'apprise-api',
    exposure: 'private',
    name: 'Apprise API',
    tagline: 'One HTTP endpoint that fans notifications out to 100+ services',
    category: 'comms',
    icon: 'lucide:megaphone',
    website: 'https://github.com/caronc/apprise-api',
    version: '1.5.4',
    postDeploy: [
      'It is private, with no public URL (Apprise API has no login). Connect the apps that send notifications to this stack; they reach it at <internal>.',
      'Save a config with curl -X POST -d "urls=tgram://…" <internal>/add/YOUR-LONG-KEY, then send with curl -d "body=Hello" <internal>/notify/YOUR-LONG-KEY.',
    ],
    notes: [
      'Apprise API has no authentication by design. Anyone who can reach the URL can send through it, and anyone who knows a config key can read the saved URLs, which contain your service tokens. swarmy deploys it private for that reason. Use long random keys.',
    ],
    yaml: `version: 1
app: apprise
services:
  apprise:
    image: caronc/apprise:v1.5.4
    port: 8000
    memory: 256mb
    env:
      APPRISE_STATEFUL_MODE: simple
      APPRISE_WORKER_COUNT: "1"
    volumes:
      config: /config
      attach: /attach
      plugin: /plugin
    healthcheck:
      path: /status
      interval: 30s
      timeout: 5s
      start_period: 30s
`,
  },
];
