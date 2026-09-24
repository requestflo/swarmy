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
];
