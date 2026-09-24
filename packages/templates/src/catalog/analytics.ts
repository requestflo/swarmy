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
];
