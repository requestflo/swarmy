import type { AppTemplate } from '../types';

export const PRODUCTIVITY_TEMPLATES: AppTemplate[] = [
  {
    id: 'paperless-ngx',
    name: 'Paperless-ngx',
    tagline: 'Scan, OCR and search every paper document you own',
    category: 'productivity',
    icon: 'paperlessngx',
    website: 'https://docs.paperless-ngx.com',
    version: '2.20.3',
    generate: {
      'secret-key': { format: 'alnum', length: 50 },
      'admin-password': { format: 'alnum', length: 20 },
    },
    reveal: ['Paperless-ngx admin login: admin / ${{ secrets.admin-password }} (shown once, so save it now)'],
    imageHealthcheck: ['paperless'],
    heavyReason: 'OCR workers want about 1 GB of RAM',
    postDeploy: [
      'Sign in as admin with the password shown above.',
      'Upload documents in the web UI or email them in (Settings → Mail).',
    ],
    yaml: `version: 1
app: paperless
services:
  paperless:
    image: ghcr.io/paperless-ngx/paperless-ngx:2.20.3
    port: 8000
    memory: 1gb
    env:
      PAPERLESS_URL: \${{ app.url }}
      PAPERLESS_REDIS: \${{ cache.url }}
      PAPERLESS_DBENGINE: postgresql
      PAPERLESS_DBHOST: \${{ db.host }}
      PAPERLESS_DBPORT: \${{ db.port }}
      PAPERLESS_DBNAME: \${{ db.database }}
      PAPERLESS_DBUSER: \${{ db.user }}
      PAPERLESS_DBPASS: \${{ db.password }}
      PAPERLESS_SECRET_KEY: \${{ secrets.secret-key }}
      PAPERLESS_ADMIN_USER: admin
      PAPERLESS_ADMIN_PASSWORD: \${{ secrets.admin-password }}
      PAPERLESS_TASK_WORKERS: "1"
      PAPERLESS_THREADS_PER_WORKER: "1"
    volumes:
      data: /usr/src/paperless/data
      media: /usr/src/paperless/media
      consume: /usr/src/paperless/consume
resources:
  db:
    type: postgres
    database: paperless
  cache:
    type: cache
    memory: 64mb
`,
  },
  {
    id: 'nextcloud',
    name: 'Nextcloud',
    tagline: 'Self-hosted file sync, sharing, calendars and contacts',
    category: 'productivity',
    icon: 'nextcloud',
    website: 'https://nextcloud.com',
    version: '34.0.4',
    generate: { 'admin-password': { format: 'alnum', length: 24 } },
    reveal: ['Nextcloud admin login: admin / ${{ secrets.admin-password }} (shown once, so save it now)'],
    heavyReason: 'Apache + PHP workers want about 768 MB, plus managed Postgres and cache',
    notes: [
      'Pinned to the latest 34.x patch release: Nextcloud advises waiting for a few patch releases before moving to a new major (35).',
      'Background jobs run in AJAX mode (on page loads). There is no system cron container, so heavy use may want a scheduled job running cron.php.',
    ],
    postDeploy: [
      'Sign in as admin with the password shown above (the first start installs Nextcloud and can take a few minutes).',
      'Open Administration settings → Overview and work through any warnings it lists.',
      'Install the desktop or mobile client and point it at <url>.',
    ],
    yaml: `version: 1
app: nextcloud
services:
  nextcloud:
    image: nextcloud:34.0.4-apache
    port: 80
    memory: 768mb
    env:
      POSTGRES_HOST: \${{ db.host }}
      POSTGRES_DB: \${{ db.database }}
      POSTGRES_USER: \${{ db.user }}
      POSTGRES_PASSWORD: \${{ db.password }}
      REDIS_HOST: \${{ cache.host }}
      REDIS_HOST_PORT: \${{ cache.port }}
      REDIS_HOST_PASSWORD: \${{ cache.password }}
      NEXTCLOUD_ADMIN_USER: admin
      NEXTCLOUD_ADMIN_PASSWORD_FILE: /run/secrets/admin-password
      NEXTCLOUD_TRUSTED_DOMAINS: \${{ app.domain }}
      OVERWRITEPROTOCOL: https
      OVERWRITECLIURL: \${{ app.url }}
      TRUSTED_PROXIES: "10.0.0.0/8 172.16.0.0/12 192.168.0.0/16"
      PHP_MEMORY_LIMIT: 512M
      PHP_UPLOAD_LIMIT: 2G
    secrets: [admin-password]
    volumes:
      html: /var/www/html
    healthcheck:
      path: /status.php
      interval: 30s
      timeout: 10s
      start_period: 300s
resources:
  db:
    type: postgres
    database: nextcloud
  cache:
    type: cache
    memory: 64mb
`,
  },
  {
    id: 'immich',
    name: 'Immich',
    tagline: 'Self-hosted photo and video backup with face and object search',
    category: 'productivity',
    icon: 'immich',
    website: 'https://immich.app',
    version: '3.2.2',
    primary: 'immich',
    generate: { 'db-password': { format: 'alnum', length: 32 } },
    imageHealthcheck: ['immich', 'machine-learning', 'database'],
    heavyReason: 'Server, machine-learning models and a vector Postgres need about 4 GB of RAM',
    notes: [
      "Immich needs its own Postgres build with the VectorChord extension, so it runs a bundled database (ghcr.io/immich-app/postgres). That database is not in swarmy DB backups; back up the database volume, and the library volume with your photos.",
      'The bundled Postgres uses file-backed dynamic shared memory, because swarm services cannot raise /dev/shm.',
      'Machine learning runs on CPU; there is no GPU acceleration here.',
    ],
    postDeploy: [
      'Open <url> and create the admin account (the first user becomes admin).',
      'Install the Immich mobile app, enter <url> as the server, and turn on backup.',
    ],
    yaml: `version: 1
app: immich
services:
  immich:
    image: ghcr.io/immich-app/immich-server:v3.2.2
    port: 2283
    memory: 1536mb
    env:
      DB_HOSTNAME: database
      DB_USERNAME: postgres
      DB_DATABASE_NAME: immich
      DB_PASSWORD_FILE: /run/secrets/db-password
      REDIS_HOSTNAME: \${{ cache.host }}
      REDIS_PORT: \${{ cache.port }}
      REDIS_PASSWORD: \${{ cache.password }}
      IMMICH_MACHINE_LEARNING_URL: http://machine-learning:3003
    secrets: [db-password]
    volumes:
      library: /data
  machine-learning:
    image: ghcr.io/immich-app/immich-machine-learning:v3.2.2
    memory: 2gb
    volumes:
      model-cache: /cache
  database:
    image: ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0
    command: ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf", "-c", "dynamic_shared_memory_type=mmap"]
    memory: 1gb
    env:
      POSTGRES_USER: postgres
      POSTGRES_DB: immich
      POSTGRES_PASSWORD_FILE: /run/secrets/db-password
      POSTGRES_INITDB_ARGS: "--data-checksums"
    secrets: [db-password]
    volumes:
      pgdata: /var/lib/postgresql/data
resources:
  cache:
    type: cache
    memory: 64mb
`,
  },
  {
    id: 'vaultwarden',
    name: 'Vaultwarden',
    tagline: 'Lightweight Bitwarden-compatible password manager server',
    category: 'productivity',
    icon: 'vaultwarden',
    website: 'https://github.com/dani-garcia/vaultwarden',
    version: '1.37.3',
    generate: { 'admin-token': { format: 'base64url', length: 48 } },
    reveal: ['Vaultwarden admin panel token (open /admin on your URL): ${{ secrets.admin-token }} (shown once, so save it now)'],
    imageHealthcheck: ['vaultwarden'],
    notes: [
      'The web vault only works over HTTPS (browsers block its crypto APIs on plain HTTP), so reach it through the swarmy HTTPS route or auto address, never a raw IP.',
      'Anyone who can reach the URL can sign up until you turn signups off.',
      'The admin token is stored as plain text; Vaultwarden logs a hint to swap it for an Argon2 hash, which you can do from the admin panel.',
    ],
    postDeploy: [
      'Open <url>, create your account, then point the Bitwarden apps and browser extension at <url> as a self-hosted server.',
      'Open <url>/admin with the token above and turn off "Allow new signups" once your accounts exist.',
      'Set SMTP in the admin panel so invites, 2FA email and password hints work.',
    ],
    yaml: `version: 1
app: vaultwarden
services:
  vaultwarden:
    image: vaultwarden/server:1.37.3
    port: 80
    memory: 256mb
    env:
      DOMAIN: \${{ app.url }}
      DATABASE_URL: \${{ db.url }}
      ADMIN_TOKEN_FILE: /run/secrets/admin-token
    secrets: [admin-token]
    volumes:
      data: /data
resources:
  db:
    type: postgres
    database: vaultwarden
`,
  },
  {
    id: 'bookstack',
    name: 'BookStack',
    tagline: 'Wiki and documentation platform organised into shelves, books and pages',
    category: 'productivity',
    icon: 'bookstack',
    website: 'https://www.bookstackapp.com',
    version: '26.05.5',
    primary: 'bookstack',
    generate: {
      'app-key': { format: 'alnum', length: 32 },
      'db-password': { format: 'alnum', length: 32 },
    },
    notes: [
      'BookStack needs MySQL or MariaDB, so it runs its own MariaDB (swarmy has no managed MySQL yet). That database is not in swarmy backups; back up the mariadb volume.',
      'APP_KEY is a raw 32-character key (Laravel AES-256), not a base64: value. Keep it: changing it breaks existing sessions and encrypted settings.',
    ],
    postDeploy: [
      'Sign in as admin@admin.com / password and change both straight away (top right → My Account).',
      'Set MAIL_* env vars for SMTP so invites and password resets send.',
    ],
    yaml: `version: 1
app: bookstack
services:
  bookstack:
    image: linuxserver/bookstack:26.05.5
    port: 80
    memory: 256mb
    env:
      PUID: "1000"
      PGID: "1000"
      APP_URL: \${{ app.url }}
      APP_KEY: \${{ secrets.app-key }}
      DB_HOST: mariadb
      DB_PORT: "3306"
      DB_USERNAME: bookstack
      DB_DATABASE: bookstack
      FILE__DB_PASSWORD: /run/secrets/db-password
    secrets: [db-password]
    volumes:
      config: /config
    healthcheck:
      path: /status
      interval: 30s
      timeout: 10s
      start_period: 120s
  mariadb:
    image: mariadb:11.8.9
    memory: 384mb
    env:
      MARIADB_DATABASE: bookstack
      MARIADB_USER: bookstack
      MARIADB_PASSWORD_FILE: /run/secrets/db-password
      MARIADB_RANDOM_ROOT_PASSWORD: "1"
    secrets: [db-password]
    volumes:
      mariadb: /var/lib/mysql
    healthcheck:
      command: ["healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 15s
      timeout: 5s
      start_period: 60s
`,
  },
  {
    id: 'wikijs',
    name: 'Wiki.js',
    tagline: 'Modern wiki with a Markdown and visual editor, search and Git sync',
    category: 'productivity',
    icon: 'wikidotjs',
    website: 'https://js.wiki',
    version: '2.5.315',
    postDeploy: [
      'Open <url> and finish the setup wizard: create the administrator account and confirm the site URL.',
      'Add pages, or set up Git storage under Administration → Storage to sync content to a repo.',
    ],
    yaml: `version: 1
app: wikijs
services:
  wiki:
    image: requarks/wiki:2.5.315
    port: 3000
    memory: 384mb
    env:
      DB_TYPE: postgres
      DB_HOST: \${{ db.host }}
      DB_PORT: \${{ db.port }}
      DB_USER: \${{ db.user }}
      DB_PASS: \${{ db.password }}
      DB_NAME: \${{ db.database }}
    volumes:
      content: /wiki/data/content
    healthcheck:
      path: /healthz
      interval: 30s
      timeout: 5s
      start_period: 90s
resources:
  db:
    type: postgres
    database: wikijs
`,
  },
  {
    id: 'docmost',
    name: 'Docmost',
    tagline: 'Collaborative wiki and docs, an open-source Notion and Confluence alternative',
    category: 'productivity',
    icon: 'lucide:file-text',
    website: 'https://docmost.com',
    version: '0.96.0',
    generate: { 'app-secret': { format: 'hex', length: 64 } },
    heavyReason: 'Node server plus managed Postgres and cache come to about 900 MB',
    postDeploy: [
      'Open <url> and create the workspace and its owner account.',
      'Set MAIL_DRIVER and SMTP_* env vars so member invites send.',
    ],
    yaml: `version: 1
app: docmost
services:
  docmost:
    image: docmost/docmost:0.96.0
    port: 3000
    memory: 512mb
    env:
      APP_URL: \${{ app.url }}
      APP_SECRET: \${{ secrets.app-secret }}
      DATABASE_URL: \${{ db.url }}
      REDIS_URL: \${{ cache.url }}
      STORAGE_DRIVER: local
    volumes:
      storage: /app/data/storage
    healthcheck:
      path: /api/health
      interval: 30s
      timeout: 10s
      start_period: 90s
resources:
  db:
    type: postgres
    database: docmost
  cache:
    type: cache
    memory: 64mb
`,
  },
  {
    id: 'memos',
    name: 'Memos',
    tagline: 'Lightweight, privacy-first notes and microblog for quick thoughts',
    category: 'productivity',
    icon: 'lucide:notebook-pen',
    website: 'https://usememos.com',
    version: '0.31.0',
    notes: ['The first account to sign up becomes the admin, so register straight after deploying.'],
    postDeploy: [
      'Open <url> and sign up; the first account is the admin.',
      'Turn off public sign-ups under Settings → System if the instance is just for you.',
    ],
    yaml: `version: 1
app: memos
services:
  memos:
    image: neosmemo/memos:0.31.0
    port: 5230
    memory: 128mb
    env:
      MEMOS_DRIVER: postgres
      MEMOS_DSN: \${{ db.url }}?sslmode=disable
      MEMOS_INSTANCE_URL: \${{ app.url }}
    volumes:
      data: /var/opt/memos
    healthcheck:
      path: /healthz
      interval: 30s
      timeout: 5s
      start_period: 30s
resources:
  db:
    type: postgres
    database: memos
`,
  },
  {
    id: 'stirling-pdf',
    name: 'Stirling-PDF',
    tagline: 'Merge, split, convert, OCR and sign PDFs in your browser',
    category: 'productivity',
    icon: 'lucide:file-cog',
    website: 'https://www.stirlingpdf.com',
    version: '2.14.3',
    generate: { 'admin-password': { format: 'alnum', length: 20 } },
    reveal: ['Stirling-PDF admin login: admin / ${{ secrets.admin-password }} (shown once, so save it now)'],
    imageHealthcheck: ['stirling'],
    heavyReason: 'Java app with LibreOffice and OCR tooling needs about 1 GB of RAM',
    notes: ['Pinned to the last 2.x release: 3.0.0 shipped the same day this template was written and has not been checked yet.'],
    postDeploy: [
      'Sign in as admin with the password shown above.',
      'Add users under Settings → Account → Admin settings, or keep it for yourself.',
    ],
    yaml: `version: 1
app: stirling-pdf
services:
  stirling:
    image: stirlingtools/stirling-pdf:2.14.3
    port: 8080
    memory: 1gb
    env:
      SECURITY_ENABLELOGIN: "true"
      SECURITY_INITIALLOGIN_USERNAME: admin
      SECURITY_INITIALLOGIN_PASSWORD: \${{ secrets.admin-password }}
      SYSTEM_DEFAULTLOCALE: en-GB
    volumes:
      configs: /configs
`,
  },
  {
    id: 'vikunja',
    name: 'Vikunja',
    tagline: 'To-do lists, kanban boards and projects for you or your team',
    category: 'productivity',
    icon: 'vikunja',
    website: 'https://vikunja.io',
    version: '2.6.0',
    generate: { 'service-secret': { format: 'alnum', length: 48 } },
    // FROM scratch: no /bin/sh for the secret-env shim.
    noShell: ['vikunja'],
    notes: [
      'Attachments are stored on the files volume, which is mounted at /tmp: that is the only directory the non-root image user (1000) can write to on a fresh named volume.',
      'Registration is open until you set VIKUNJA_SERVICE_ENABLEREGISTRATION=false.',
    ],
    postDeploy: [
      'Open <url> and register your account.',
      'Set VIKUNJA_SERVICE_ENABLEREGISTRATION to false and redeploy once everyone has an account.',
    ],
    yaml: `version: 1
app: vikunja
services:
  vikunja:
    image: vikunja/vikunja:2.6.0
    port: 3456
    memory: 256mb
    env:
      VIKUNJA_SERVICE_PUBLICURL: \${{ app.url }}/
      VIKUNJA_SERVICE_SECRET: \${{ secrets.service-secret }}
      VIKUNJA_DATABASE_TYPE: postgres
      VIKUNJA_DATABASE_HOST: \${{ db.host }}
      VIKUNJA_DATABASE_USER: \${{ db.user }}
      VIKUNJA_DATABASE_PASSWORD: \${{ db.password }}
      VIKUNJA_DATABASE_DATABASE: \${{ db.database }}
      VIKUNJA_FILES_BASEPATH: /tmp
    volumes:
      files: /tmp
    healthcheck:
      command: ["/app/vikunja/vikunja", "healthcheck"]
      interval: 60s
      timeout: 10s
      start_period: 60s
resources:
  db:
    type: postgres
    database: vikunja
`,
  },
  {
    id: 'actual-budget',
    name: 'Actual Budget',
    tagline: 'Local-first envelope budgeting with sync across your devices',
    category: 'productivity',
    icon: 'actualbudget',
    website: 'https://actualbudget.org',
    version: '26.9.0',
    postDeploy: [
      'Open <url> and set the server password.',
      'Create a budget, or import one from YNAB or an Actual export.',
    ],
    yaml: `version: 1
app: actual
services:
  actual:
    image: actualbudget/actual-server:26.9.0
    port: 5006
    memory: 256mb
    volumes:
      data: /data
    healthcheck:
      command: ["node", "-e", "require('http').get('http://127.0.0.1:5006/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 30s
      timeout: 10s
      start_period: 30s
`,
  },
  {
    id: 'mealie',
    name: 'Mealie',
    tagline: 'Recipe manager and meal planner that imports recipes from any URL',
    category: 'productivity',
    icon: 'mealie',
    website: 'https://mealie.io',
    version: '3.28.0',
    imageHealthcheck: ['mealie'],
    postDeploy: [
      'Sign in with changeme@example.com / MyPassword, then change the email and password straight away (User settings).',
      'Invite household members under Settings → Users, or paste a recipe URL to import your first recipe.',
    ],
    yaml: `version: 1
app: mealie
services:
  mealie:
    image: ghcr.io/mealie-recipes/mealie:v3.28.0
    port: 9000
    memory: 512mb
    env:
      BASE_URL: \${{ app.url }}
      ALLOW_SIGNUP: "false"
      DB_ENGINE: postgres
      POSTGRES_SERVER: \${{ db.host }}
      POSTGRES_PORT: \${{ db.port }}
      POSTGRES_USER: \${{ db.user }}
      POSTGRES_PASSWORD: \${{ db.password }}
      POSTGRES_DB: \${{ db.database }}
    volumes:
      data: /app/data
resources:
  db:
    type: postgres
    database: mealie
`,
  },
  {
    id: 'linkding',
    name: 'linkding',
    tagline: 'Minimal, fast bookmark manager with tags and archiving',
    category: 'productivity',
    icon: 'lucide:bookmark',
    website: 'https://linkding.link',
    version: '1.47.0',
    generate: { 'admin-password': { format: 'alnum', length: 20 } },
    reveal: ['linkding admin login: admin / ${{ secrets.admin-password }} (shown once, so save it now)'],
    imageHealthcheck: ['linkding'],
    postDeploy: [
      'Sign in as admin with the password shown above.',
      'Install the browser extension or bookmarklet from Settings → Integrations.',
    ],
    yaml: `version: 1
app: linkding
services:
  linkding:
    image: sissbruecker/linkding:1.47.0
    port: 9090
    memory: 256mb
    env:
      LD_SUPERUSER_NAME: admin
      LD_SUPERUSER_PASSWORD: \${{ secrets.admin-password }}
      LD_CSRF_TRUSTED_ORIGINS: \${{ app.url }}
      LD_DB_ENGINE: postgres
      LD_DB_HOST: \${{ db.host }}
      LD_DB_PORT: \${{ db.port }}
      LD_DB_USER: \${{ db.user }}
      LD_DB_PASSWORD: \${{ db.password }}
      LD_DB_DATABASE: \${{ db.database }}
    volumes:
      data: /etc/linkding/data
resources:
  db:
    type: postgres
    database: linkding
`,
  },
  {
    id: 'miniflux',
    name: 'Miniflux',
    tagline: 'Minimalist, opinionated RSS and Atom feed reader',
    category: 'productivity',
    icon: 'lucide:rss',
    website: 'https://miniflux.app',
    version: '2.3.3',
    generate: { 'admin-password': { format: 'alnum', length: 20 } },
    reveal: ['Miniflux admin login: admin / ${{ secrets.admin-password }} (shown once, so save it now)'],
    postDeploy: [
      'Sign in as admin with the password shown above.',
      'Add feeds, or import an OPML file under Settings → Import.',
    ],
    yaml: `version: 1
app: miniflux
services:
  miniflux:
    image: miniflux/miniflux:2.3.3
    port: 8080
    memory: 128mb
    env:
      DATABASE_URL: \${{ db.url }}?sslmode=disable
      RUN_MIGRATIONS: "1"
      CREATE_ADMIN: "1"
      ADMIN_USERNAME: admin
      ADMIN_PASSWORD_FILE: /run/secrets/admin-password
      BASE_URL: \${{ app.url }}
    secrets: [admin-password]
    healthcheck:
      command: ["/usr/bin/miniflux", "-healthcheck", "auto"]
      interval: 30s
      timeout: 5s
      start_period: 30s
resources:
  db:
    type: postgres
    database: miniflux
`,
  },
  {
    id: 'planka',
    name: 'Planka',
    tagline: 'Real-time kanban boards for projects and teams, a Trello alternative',
    category: 'productivity',
    icon: 'lucide:kanban',
    website: 'https://planka.app',
    version: '2.2.1',
    generate: {
      'secret-key': { format: 'hex', length: 64 },
      'admin-password': { format: 'alnum', length: 20 },
    },
    reveal: ['Planka admin login: admin / ${{ secrets.admin-password }} (shown once, so save it now)'],
    imageHealthcheck: ['planka'],
    notes: ['The admin is seeded as admin@example.com and cannot be deleted while DEFAULT_ADMIN_EMAIL is set; change DEFAULT_ADMIN_EMAIL to your address and redeploy if you want real notifications.'],
    postDeploy: [
      'Sign in as admin with the password shown above.',
      'Create a project and invite members, and set SMTP_* env vars for email notifications.',
    ],
    yaml: `version: 1
app: planka
services:
  planka:
    image: ghcr.io/plankanban/planka:2.2.1
    port: 1337
    memory: 384mb
    env:
      BASE_URL: \${{ app.url }}
      DATABASE_URL: \${{ db.url }}
      SECRET_KEY__FILE: /run/secrets/secret-key
      TRUST_PROXY: "true"
      DEFAULT_ADMIN_EMAIL: admin@example.com
      DEFAULT_ADMIN_USERNAME: admin
      DEFAULT_ADMIN_NAME: Admin
      DEFAULT_ADMIN_PASSWORD__FILE: /run/secrets/admin-password
    secrets: [secret-key, admin-password]
    volumes:
      data: /app/data
resources:
  db:
    type: postgres
    database: planka
`,
  },
  {
    id: 'filebrowser',
    name: 'File Browser',
    tagline: 'Web file manager to upload, organise, preview and share files',
    category: 'productivity',
    icon: 'lucide:folder-open',
    website: 'https://filebrowser.org',
    version: '2.63.23',
    imageHealthcheck: ['filebrowser'],
    notes: ['File Browser only accepts a pre-hashed admin password at setup, so it generates its own on first start and prints it to the service logs.'],
    postDeploy: [
      'Open the service logs and find "User \'admin\' initialized with randomly generated password", then sign in as admin with it.',
      'Change the password under Settings → Profile, and add users under Settings → User Management.',
    ],
    yaml: `version: 1
app: filebrowser
services:
  filebrowser:
    image: filebrowser/filebrowser:v2.63.23
    port: 80
    memory: 128mb
    volumes:
      files: /srv
      database: /database
      config: /config
`,
  },
  {
    id: 'hedgedoc',
    name: 'HedgeDoc',
    tagline: 'Real-time collaborative Markdown notes, slides and diagrams',
    category: 'productivity',
    icon: 'hedgedoc',
    website: 'https://hedgedoc.org',
    version: '1.12.0',
    generate: { 'session-secret': { format: 'hex', length: 64 } },
    imageHealthcheck: ['hedgedoc'],
    notes: ['Guests can create and edit notes without an account by default; set CMD_ALLOW_ANONYMOUS=false and CMD_ALLOW_ANONYMOUS_EDITS=false to lock it down.'],
    postDeploy: [
      'Open <url>, register with email and password, and create a note.',
      'Once your accounts exist, set CMD_ALLOW_EMAIL_REGISTER=false and redeploy.',
    ],
    yaml: `version: 1
app: hedgedoc
services:
  hedgedoc:
    image: quay.io/hedgedoc/hedgedoc:1.12.0
    port: 3000
    memory: 384mb
    env:
      CMD_DB_URL: \${{ db.url }}
      CMD_DOMAIN: \${{ app.domain }}
      CMD_PROTOCOL_USESSL: "true"
      CMD_URL_ADDPORT: "false"
      CMD_SESSION_SECRET: \${{ secrets.session-secret }}
      CMD_EMAIL: "true"
      CMD_ALLOW_EMAIL_REGISTER: "true"
    volumes:
      uploads: /hedgedoc/public/uploads
resources:
  db:
    type: postgres
    database: hedgedoc
`,
  },
  {
    id: 'searxng',
    name: 'SearXNG',
    tagline: 'Private metasearch engine that queries many search engines without tracking you',
    category: 'productivity',
    icon: 'searxng',
    website: 'https://docs.searxng.org',
    version: '2026.9.23',
    generate: { 'secret-key': { format: 'hex', length: 64 } },
    notes: ['The bot limiter is on and keeps its counters in the managed cache. It trusts X-Forwarded-For from private ranges, which covers the swarmy ingress.'],
    postDeploy: [
      'Open <url> and search.',
      'Set it as your browser search engine: <url>/search?q=%s',
    ],
    yaml: `version: 1
app: searxng
services:
  searxng:
    image: searxng/searxng:2026.9.23-3cd69d30e
    port: 8080
    memory: 384mb
    env:
      SEARXNG_BASE_URL: \${{ app.url }}/
      SEARXNG_SECRET: \${{ secrets.secret-key }}
      SEARXNG_LIMITER: "true"
      SEARXNG_VALKEY_URL: valkey://:\${{ cache.password }}@\${{ cache.host }}:\${{ cache.port }}/0
    volumes:
      config: /etc/searxng
      searx-cache: /var/cache/searxng
    healthcheck:
      path: /healthz
      interval: 30s
      timeout: 5s
      start_period: 30s
resources:
  cache:
    type: cache
    memory: 64mb
`,
  },
];
