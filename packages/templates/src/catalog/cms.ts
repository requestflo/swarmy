import type { AppTemplate } from '../types';

// WordPress and Directus ship as hand-written blueprints (blueprints/catalog.ts).

export const CMS_TEMPLATES: AppTemplate[] = [
  {
    id: 'ghost',
    name: 'Ghost',
    tagline: 'Publishing platform for blogs and paid newsletters',
    category: 'cms',
    icon: 'ghost',
    website: 'https://ghost.org',
    version: '6.65.0',
    generate: { 'db-password': { format: 'alnum', length: 32 } },
    notes: ['Ghost needs MySQL 8 in production, so it runs its own MySQL (swarmy has no managed MySQL yet). That database is not in swarmy backups; back up the volume.'],
    postDeploy: [
      'Open <url>/ghost to create the owner account.',
      'Staff invites and newsletters send through the swarmy email service when it is on (wired on deploy); otherwise add mail__* env vars for your own SMTP.',
    ],
    yaml: `version: 1
app: ghost
services:
  ghost:
    image: ghost:6.65.0
    port: 2368
    memory: 384mb
    env:
      url: \${{ app.url }}
      NODE_ENV: production
      database__client: mysql
      database__connection__host: mysql
      database__connection__user: ghost
      database__connection__database: ghost
      database__connection__password: \${{ secrets.db-password }}
      mail__transport: SMTP
      mail__from: \${{ email.from }}
      mail__options__host: \${{ email.host }}
      mail__options__port: \${{ email.port }}
      mail__options__secure: "false"
      mail__options__auth__user: \${{ email.user }}
      mail__options__auth__pass: \${{ email.password }}
    volumes:
      content: /var/lib/ghost/content
    healthcheck:
      command: ["node", "-e", "require('http').get('http://127.0.0.1:2368/ghost/api/admin/site/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"]
      interval: 30s
      timeout: 10s
      start_period: 90s
  mysql:
    image: mysql:8.4.7
    # 8.4's first-boot init peaks ~450 MiB; at 384mb it is OOM-killed mid-init
    # and leaves a data dir whose 'ghost' user can't connect (QA-018).
    memory: 768mb
    env:
      MYSQL_DATABASE: ghost
      MYSQL_USER: ghost
      MYSQL_PASSWORD_FILE: /run/secrets/db-password
      MYSQL_RANDOM_ROOT_PASSWORD: "1"
    secrets: [db-password]
    volumes:
      mysql: /var/lib/mysql
    healthcheck:
      command: ["mysqladmin", "ping", "-h", "127.0.0.1", "--silent"]
      interval: 15s
      timeout: 5s
      start_period: 60s
email:
  services: [ghost]
`,
  },
];
