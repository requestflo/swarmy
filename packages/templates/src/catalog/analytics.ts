import type { AppTemplate } from '../types';

export const ANALYTICS_TEMPLATES: AppTemplate[] = [
  {
    id: 'umami',
    name: 'Umami',
    tagline: 'Simple, privacy-friendly web analytics without cookies',
    category: 'analytics',
    icon: 'umami',
    website: 'https://umami.is',
    version: '3.4.0',
    generate: { 'app-secret': { format: 'hex', length: 64 } },
    postDeploy: [
      'Sign in with admin / umami and change the password right away (Settings → Profile).',
      'Add a website and paste its tracking script into your site.',
    ],
    yaml: `version: 1
app: umami
services:
  umami:
    image: ghcr.io/umami-software/umami:3.4.0
    port: 3000
    memory: 384mb
    env:
      DATABASE_URL: \${{ db.url }}
      APP_SECRET: \${{ secrets.app-secret }}
    healthcheck:
      path: /api/heartbeat
      interval: 30s
      timeout: 5s
      start_period: 60s
resources:
  db:
    type: postgres
    database: umami
`,
  },
  {
    id: 'plausible',
    name: 'Plausible CE',
    tagline: 'Lightweight, cookie-free web analytics you host yourself',
    category: 'analytics',
    icon: 'plausibleanalytics',
    website: 'https://plausible.io',
    version: '3.2.1',
    generate: { 'secret-key-base': { format: 'base64url', length: 86 } },
    heavyReason: 'Plausible stores events in ClickHouse, which wants about 1 GB of RAM on its own',
    notes: [
      'Plausible stores its events in ClickHouse, so this template runs its own ClickHouse (swarmy has no managed ClickHouse). That database is not in swarmy backups; back up the clickhouse volume.',
      'ClickHouse runs with its stock system log tables, so its volume grows slowly over time.',
      'Email (password resets, reports) is off until you add SMTP settings (MAILER_EMAIL, SMTP_HOST_ADDR and friends) to the plausible service.',
    ],
    postDeploy: [
      'Open <url>/register and create the first account, which becomes the owner. Registration closes after that.',
      'Add your site and paste the tracking snippet into its <head>.',
    ],
    yaml: `version: 1
app: plausible
services:
  plausible:
    image: ghcr.io/plausible/community-edition:v3.2.1
    command: ["sh", "-c", "/entrypoint.sh db createdb && /entrypoint.sh db migrate && /entrypoint.sh run"]
    port: 8000
    memory: 512mb
    env:
      BASE_URL: \${{ app.url }}
      SECRET_KEY_BASE: \${{ secrets.secret-key-base }}
      DATABASE_URL: \${{ db.url }}
      CLICKHOUSE_DATABASE_URL: http://clickhouse:8123/plausible_events_db
      HTTP_PORT: "8000"
      LISTEN_IP: 0.0.0.0
      TMPDIR: /var/lib/plausible/tmp
    volumes:
      data: /var/lib/plausible
    healthcheck:
      path: /api/health
      interval: 30s
      timeout: 10s
      start_period: 120s
  clickhouse:
    image: clickhouse/clickhouse-server:24.12.6-alpine
    command: ["--", "--logger.level=warning", "--logger.console=1", "--mark_cache_size=524288000"]
    memory: 1gb
    env:
      CLICKHOUSE_SKIP_USER_SETUP: "1"
    volumes:
      clickhouse: /var/lib/clickhouse
    healthcheck:
      command: ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8123/ping"]
      interval: 15s
      timeout: 5s
      start_period: 60s
resources:
  db:
    type: postgres
    database: plausible
`,
  },
  {
    id: 'matomo',
    name: 'Matomo',
    tagline: 'Full-featured Google Analytics alternative that keeps the data on your server',
    category: 'analytics',
    icon: 'matomo',
    website: 'https://matomo.org',
    version: '5.14.0',
    generate: { 'db-password': { format: 'alnum', length: 32 } },
    notes: [
      'Matomo needs MySQL or MariaDB, so it runs its own MariaDB (swarmy has no managed MySQL yet). That database is not in swarmy backups; back up the mariadb volume.',
      'Reports are archived when someone opens the dashboard (browser-triggered archiving). For busy sites, set up the core:archive cron as the Matomo docs describe.',
    ],
    postDeploy: [
      'Open the URL and step through the installer. The database settings are filled in for you, so keep them.',
      'Create the superuser, add your first website and paste the tracking code into it.',
    ],
    yaml: `version: 1
app: matomo
services:
  matomo:
    image: matomo:5.14.0
    port: 80
    memory: 384mb
    env:
      MATOMO_DATABASE_HOST: mariadb
      MATOMO_DATABASE_ADAPTER: mysql
      MATOMO_DATABASE_TABLES_PREFIX: matomo_
      MATOMO_DATABASE_USERNAME: matomo
      MATOMO_DATABASE_PASSWORD: \${{ secrets.db-password }}
      MATOMO_DATABASE_DBNAME: matomo
    volumes:
      html: /var/www/html
    healthcheck:
      path: /matomo.js
      interval: 30s
      timeout: 10s
      start_period: 60s
  mariadb:
    image: mariadb:11.8.9
    memory: 384mb
    env:
      MARIADB_DATABASE: matomo
      MARIADB_USER: matomo
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
    id: 'goatcounter',
    name: 'GoatCounter',
    tagline: 'Tiny, privacy-first web analytics with a no-nonsense dashboard',
    category: 'analytics',
    icon: 'lucide:chart-line',
    website: 'https://www.goatcounter.com',
    version: '2.7.0',
    postDeploy: [
      'Open the URL and fill in the first-run form: your email, a password and this site’s domain as the vhost.',
      'Copy the count.js snippet from Settings → Site code into your pages.',
    ],
    yaml: `version: 1
app: goatcounter
services:
  goatcounter:
    image: arp242/goatcounter:2.7.0
    port: 8080
    memory: 128mb
    env:
      GOATCOUNTER_DB: postgresql+postgresql://\${{ db.user }}:\${{ db.password }}@\${{ db.host }}:\${{ db.port }}/\${{ db.database }}?sslmode=disable
      GOATCOUNTER_LISTEN: ":8080"
      GOATCOUNTER_TLS: http
    volumes:
      data: /home/goatcounter/goatcounter-data
    healthcheck:
      path: /status
      interval: 30s
      timeout: 5s
      start_period: 30s
resources:
  db:
    type: postgres
    database: goatcounter
`,
  },
];
