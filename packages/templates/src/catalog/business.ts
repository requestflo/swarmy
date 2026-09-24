import type { AppTemplate } from '../types';

// Not here:
//  - Formbricks: since v5 the web app expects its hub and cube services plus one-shot migrate jobs,
//    and v6 adds SpiceDB on top, which is too many moving parts to ship one-click correct.
//  - Typebot: sign-in needs SMTP (magic links) or an OAuth app registered first, and the viewer
//    needs a second public URL next to the builder's.

export const BUSINESS_TEMPLATES: AppTemplate[] = [
  {
    id: 'listmonk',
    name: 'listmonk',
    tagline: 'Fast, self-hosted newsletter and mailing list manager',
    category: 'business',
    icon: 'listmonk',
    website: 'https://listmonk.app',
    version: '6.2.0',
    generate: { 'admin-password': { format: 'alnum', length: 20 } },
    reveal: ['listmonk admin login: admin / ${{ secrets.admin-password }} (shown once, so save it now)'],
    notes: ['listmonk sends mail through an SMTP server you configure in Settings → SMTP; nothing goes out until you do.'],
    postDeploy: [
      'Sign in as admin with the password shown above.',
      'In Settings → General, set the Root URL to <url>, then add your SMTP server under Settings → SMTP.',
    ],
    yaml: `version: 1
app: listmonk
services:
  listmonk:
    image: listmonk/listmonk:v6.2.0
    command: ["sh", "-c", "./listmonk --install --idempotent --yes --config '' && ./listmonk --upgrade --yes --config '' && exec ./listmonk --config ''"]
    port: 9000
    memory: 128mb
    env:
      LISTMONK_app__address: 0.0.0.0:9000
      LISTMONK_db__host: \${{ db.host }}
      LISTMONK_db__port: \${{ db.port }}
      LISTMONK_db__user: \${{ db.user }}
      LISTMONK_db__password: \${{ db.password }}
      LISTMONK_db__database: \${{ db.database }}
      LISTMONK_db__ssl_mode: disable
      LISTMONK_ADMIN_USER: admin
      LISTMONK_ADMIN_PASSWORD_FILE: /run/secrets/admin-password
      TZ: Etc/UTC
    secrets: [admin-password]
    volumes:
      uploads: /listmonk/uploads
    healthcheck:
      path: /health
      interval: 30s
      timeout: 5s
      start_period: 60s
resources:
  db:
    type: postgres
    database: listmonk
`,
  },
  {
    id: 'calcom',
    name: 'Cal.com',
    tagline: 'Scheduling infrastructure: booking pages, availability and calendar sync',
    category: 'business',
    icon: 'caldotcom',
    website: 'https://cal.com',
    version: '6.2.0',
    generate: {
      'nextauth-secret': { format: 'base64url', length: 43 },
      'encryption-key': { format: 'alnum', length: 32 },
    },
    imageHealthcheck: ['calcom'],
    heavyReason: 'The Next.js app plus its first-boot migrations want about 1 GB of RAM',
    notes: [
      'The first boot rewrites the built-in URL and runs all database migrations, so it can take a few minutes before the app answers.',
      'Email (booking confirmations, invites) is off until you add EMAIL_FROM and EMAIL_SERVER_* env vars for SMTP.',
      'Calendar and video integrations (Google, Microsoft, Zoom) each need their own OAuth app, set up later in the admin settings.',
    ],
    postDeploy: [
      'Open <url>/auth/setup and create the admin account.',
      'Connect a calendar under Settings → Calendars, then share your booking page.',
    ],
    yaml: `version: 1
app: calcom
services:
  calcom:
    image: calcom/cal.com:v6.2.0
    port: 3000
    memory: 1gb
    env:
      NEXT_PUBLIC_WEBAPP_URL: \${{ app.url }}
      NEXTAUTH_URL: \${{ app.url }}/api/auth
      NEXTAUTH_SECRET: \${{ secrets.nextauth-secret }}
      CALENDSO_ENCRYPTION_KEY: \${{ secrets.encryption-key }}
      DATABASE_URL: \${{ db.url }}
      DATABASE_DIRECT_URL: \${{ db.url }}
      DATABASE_HOST: \${{ db.host }}:\${{ db.port }}
      CALCOM_TELEMETRY_DISABLED: "1"
      NODE_OPTIONS: --max-old-space-size=768
resources:
  db:
    type: postgres
    database: calcom
`,
  },
  {
    id: 'chatwoot',
    name: 'Chatwoot',
    tagline: 'Customer support inbox for live chat, email and social channels',
    category: 'business',
    icon: 'chatwoot',
    website: 'https://www.chatwoot.com',
    version: '4.18.0',
    primary: 'web',
    generate: { 'secret-key-base': { format: 'hex', length: 128 } },
    heavyReason: 'A Rails web server plus a Sidekiq worker want well over 1 GB of RAM together',
    notes: [
      'The web service prepares the database (db:chatwoot_prepare) every time it starts; it is safe to repeat, and the first run takes a minute or two.',
      'Uploads live on the storage volume, which web and sidekiq share. swarmy pins both services to one node, because Docker volumes are per node. To spread them out, switch ACTIVE_STORAGE_SERVICE to S3.',
      'Email notifications and the email channel need SMTP settings (SMTP_ADDRESS, MAILER_SENDER_EMAIL and friends) on both services.',
    ],
    postDeploy: [
      'Open the URL to create the super admin account and your first workspace.',
      'Add an inbox (Settings → Inboxes), e.g. a website live chat widget, and paste its script into your site.',
    ],
    yaml: `version: 1
app: chatwoot
env:
  RAILS_ENV: production
  NODE_ENV: production
  INSTALLATION_ENV: docker
  RAILS_LOG_TO_STDOUT: "true"
  FRONTEND_URL: \${{ app.url }}
  SECRET_KEY_BASE: \${{ secrets.secret-key-base }}
  POSTGRES_HOST: \${{ db.host }}
  POSTGRES_PORT: \${{ db.port }}
  POSTGRES_USERNAME: \${{ db.user }}
  POSTGRES_PASSWORD: \${{ db.password }}
  POSTGRES_DATABASE: \${{ db.database }}
  REDIS_URL: \${{ cache.url }}
  REDIS_PASSWORD: \${{ cache.password }}
  ACTIVE_STORAGE_SERVICE: local
  ENABLE_ACCOUNT_SIGNUP: "false"
services:
  web:
    image: chatwoot/chatwoot:v4.18.0
    command: "rm -f /app/tmp/pids/server.pid && bundle exec rails db:chatwoot_prepare && exec bundle exec rails s -p 3000 -b 0.0.0.0"
    port: 3000
    memory: 768mb
    volumes:
      storage: /app/storage
    healthcheck:
      path: /api
      interval: 30s
      timeout: 10s
      start_period: 300s
  sidekiq:
    image: chatwoot/chatwoot:v4.18.0
    command: ["bundle", "exec", "sidekiq", "-C", "config/sidekiq.yml"]
    memory: 512mb
    volumes:
      storage: /app/storage
    healthcheck:
      command: ["pgrep", "-f", "sidekiq"]
      interval: 30s
      timeout: 5s
      start_period: 120s
resources:
  db:
    type: postgres
    database: chatwoot
  cache:
    type: cache
    memory: 64mb
`,
  },
  {
    id: 'mautic',
    name: 'Mautic',
    tagline: 'Open-source marketing automation: segments, campaigns and email',
    category: 'business',
    icon: 'mautic',
    website: 'https://www.mautic.org',
    version: '7.2.1',
    primary: 'web',
    generate: { 'db-password': { format: 'alnum', length: 32 } },
    heavyReason: 'The PHP web app, its cron runner and MariaDB together want well over 1 GB of RAM',
    notes: [
      'Mautic needs MySQL or MariaDB, so it runs its own MariaDB (swarmy has no managed MySQL yet). That database is not in swarmy backups; back up the mariadb volume.',
      'The cron service runs the segment and campaign jobs and reads the config volume the installer writes. swarmy pins web and cron to one node, because Docker volumes are per node.',
      'Email and tracking hits are processed right away (sync://) rather than through a queue worker, which is fine for small lists.',
    ],
    postDeploy: [
      'Open the URL and run the installer. The database settings are filled in for you, so keep them.',
      'Create the admin user, then set up email sending under Settings → Configuration → Email Settings.',
    ],
    yaml: `version: 1
app: mautic
services:
  web:
    image: mautic/mautic:7.2.1-apache
    port: 80
    memory: 512mb
    env:
      DOCKER_MAUTIC_ROLE: mautic_web
      MAUTIC_DB_HOST: mariadb
      MAUTIC_DB_PORT: "3306"
      MAUTIC_DB_DATABASE: mautic
      MAUTIC_DB_USER: mautic
      MAUTIC_DB_PASSWORD: \${{ secrets.db-password }}
      MAUTIC_CONFIG_PARAMETERS: '{"trusted_proxies":["0.0.0.0/0"],"messenger_dsn_email":"sync://","messenger_dsn_hit":"sync://"}'
    volumes:
      config: /var/www/html/config
      logs: /var/www/html/var/logs
      files: /var/www/html/docroot/media/files
      images: /var/www/html/docroot/media/images
    healthcheck:
      path: /
      interval: 30s
      timeout: 10s
      start_period: 120s
  cron:
    image: mautic/mautic:7.2.1-apache
    memory: 384mb
    env:
      DOCKER_MAUTIC_ROLE: mautic_cron
      MAUTIC_DB_HOST: mariadb
      MAUTIC_DB_PORT: "3306"
      MAUTIC_DB_DATABASE: mautic
      MAUTIC_DB_USER: mautic
      MAUTIC_DB_PASSWORD: \${{ secrets.db-password }}
      MAUTIC_CONFIG_PARAMETERS: '{"trusted_proxies":["0.0.0.0/0"],"messenger_dsn_email":"sync://","messenger_dsn_hit":"sync://"}'
    volumes:
      config: /var/www/html/config
      logs: /var/www/html/var/logs
      files: /var/www/html/docroot/media/files
      images: /var/www/html/docroot/media/images
    healthcheck:
      command: ["sh", "-c", "grep -qsx cron /proc/[0-9]*/comm || ! grep -qs site_url /var/www/html/config/local.php"]
      interval: 60s
      timeout: 10s
      start_period: 120s
  mariadb:
    image: mariadb:11.8.9
    memory: 384mb
    env:
      MARIADB_DATABASE: mautic
      MARIADB_USER: mautic
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
];
