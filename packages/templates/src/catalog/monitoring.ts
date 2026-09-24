import type { AppTemplate } from '../types';

export const MONITORING_TEMPLATES: AppTemplate[] = [
  {
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    tagline: 'Uptime monitoring and status pages for your sites and services',
    category: 'monitoring',
    icon: 'uptimekuma',
    website: 'https://uptime.kuma.pet',
    version: '2.5.5',
    imageHealthcheck: ['kuma'],
    postDeploy: [
      'Open the URL, choose SQLite as the database, then create the admin account.',
      'Add monitors, and a notification channel under Settings → Notifications.',
    ],
    yaml: `version: 1
app: uptime-kuma
services:
  kuma:
    image: louislam/uptime-kuma:2.5.5
    port: 3001
    memory: 256mb
    volumes:
      data: /app/data
`,
  },
  {
    id: 'grafana',
    name: 'Grafana',
    tagline: 'Dashboards and alerting for metrics, logs and traces',
    category: 'monitoring',
    icon: 'grafana',
    website: 'https://grafana.com/oss/grafana',
    version: '13.2.2',
    generate: {
      'admin-password': { format: 'alnum', length: 24 },
      'secret-key': { format: 'alnum', length: 32 },
    },
    reveal: ['Grafana admin login: admin / ${{ secrets.admin-password }} (shown once, so save it now)'],
    postDeploy: [
      'Sign in at <url> as admin with the password shown above.',
      'Add a data source under Connections → Data sources (Prometheus, Loki, Postgres and so on), then build or import a dashboard.',
    ],
    notes: ['Dashboards, users and alert rules live in the managed Postgres database, so swarmy DB backups cover them. Installed plugins live on the data volume.'],
    yaml: `version: 1
app: grafana
services:
  grafana:
    image: grafana/grafana:13.2.2
    port: 3000
    memory: 256mb
    env:
      GF_SERVER_ROOT_URL: \${{ app.url }}
      GF_DATABASE_TYPE: postgres
      GF_DATABASE_HOST: "\${{ db.host }}:\${{ db.port }}"
      GF_DATABASE_NAME: \${{ db.database }}
      GF_DATABASE_USER: \${{ db.user }}
      GF_DATABASE_PASSWORD: \${{ db.password }}
      GF_DATABASE_SSL_MODE: disable
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD__FILE: /run/secrets/admin-password
      GF_SECURITY_SECRET_KEY__FILE: /run/secrets/secret-key
      GF_ANALYTICS_REPORTING_ENABLED: "false"
    secrets: [admin-password, secret-key]
    volumes:
      data: /var/lib/grafana
    healthcheck:
      path: /api/health
      interval: 30s
      timeout: 5s
      start_period: 60s
resources:
  db:
    type: postgres
    database: grafana
`,
  },
  {
    id: 'changedetection',
    name: 'changedetection.io',
    tagline: 'Watch web pages for changes and get notified when they update',
    category: 'monitoring',
    icon: 'changedetection',
    website: 'https://changedetection.io',
    version: '0.60.7',
    postDeploy: [
      'Open <url> and set a password right away under Settings → General → Password: the UI is open to anyone until you do.',
      'Add a URL to watch, then add a notification target (Apprise URL, email, ntfy and so on) under Settings → Notifications.',
    ],
    notes: [
      'There is no bundled Playwright browser, so pages that need JavaScript to render are fetched as plain HTML. Add a sockpuppetbrowser service and PLAYWRIGHT_DRIVER_URL if you need it.',
    ],
    yaml: `version: 1
app: changedetection
services:
  changedetection:
    image: ghcr.io/dgtlmoon/changedetection.io:0.60.7
    port: 5000
    memory: 384mb
    env:
      BASE_URL: \${{ app.url }}
    volumes:
      datastore: /datastore
    healthcheck:
      command: ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/', timeout=5)"]
      interval: 30s
      timeout: 10s
      start_period: 60s
`,
  },
  {
    id: 'beszel',
    name: 'Beszel',
    tagline: 'Lightweight server monitoring with Docker stats and alerts',
    category: 'monitoring',
    icon: 'lucide:server',
    website: 'https://beszel.dev',
    version: '0.20.0',
    postDeploy: [
      'Open <url> and create the admin account (the first account becomes the admin).',
      'Click Add System and follow the shown command to install the Beszel agent on each host you want to monitor, using the WebSocket (token + hub URL) option so the agent dials out to <url>.',
    ],
    notes: [
      'This deploys the web hub only. Agents run separately on each monitored machine and are not part of this template.',
      'Use the agent mode that connects out to the hub over HTTPS: the hub cannot reach an agent on port 45876 through the swarmy route.',
    ],
    yaml: `version: 1
app: beszel
services:
  beszel:
    image: henrygd/beszel:0.20.0
    port: 8090
    memory: 128mb
    env:
      APP_URL: \${{ app.url }}
    volumes:
      data: /beszel_data
    healthcheck:
      command: ["/beszel", "health", "--url", "http://localhost:8090"]
      interval: 30s
      timeout: 5s
      start_period: 30s
`,
  },
  {
    id: 'healthchecks',
    name: 'Healthchecks',
    tagline: 'Cron job monitoring that alerts you when a scheduled task goes quiet',
    category: 'monitoring',
    icon: 'lucide:heart-pulse',
    website: 'https://healthchecks.io',
    version: '4.4',
    generate: { 'secret-key': { format: 'alnum', length: 50 } },
    imageHealthcheck: ['healthchecks'],
    postDeploy: [
      'Open a terminal in the healthchecks service and run ./manage.py createsuperuser to create your login (public sign-up is off).',
      'Sign in at <url>, create a check, and ping its URL from the end of your cron job.',
      'Email alerts and invites need SMTP: add EMAIL_HOST, EMAIL_PORT, EMAIL_HOST_USER, EMAIL_HOST_PASSWORD and DEFAULT_FROM_EMAIL env vars, then redeploy.',
    ],
    notes: [
      'Healthchecks has no env var to seed an admin, so the first user is created from the service terminal.',
      'Without SMTP, alerts still go to non-email integrations (Slack, ntfy, Telegram, webhooks and so on).',
    ],
    yaml: `version: 1
app: healthchecks
services:
  healthchecks:
    image: healthchecks/healthchecks:v4.4
    port: 8000
    memory: 384mb
    env:
      SITE_ROOT: \${{ app.url }}
      SITE_NAME: Healthchecks
      DEBUG: "False"
      REGISTRATION_OPEN: "False"
      UWSGI_PROCESSES: "2"
      SECRET_KEY: \${{ secrets.secret-key }}
      DB: postgres
      DB_HOST: \${{ db.host }}
      DB_PORT: \${{ db.port }}
      DB_NAME: \${{ db.database }}
      DB_USER: \${{ db.user }}
      DB_PASSWORD: \${{ db.password }}
resources:
  db:
    type: postgres
    database: healthchecks
`,
  },
];
