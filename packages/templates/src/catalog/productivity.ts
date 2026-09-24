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
];
