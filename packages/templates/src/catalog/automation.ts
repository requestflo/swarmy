import type { AppTemplate } from '../types';

// Node-RED is not here: its editor has no env or CLI way to seed a login (adminAuth needs a bcrypt
// hash in settings.js), so a one-click deploy would put an unauthenticated code-running editor online.

export const AUTOMATION_TEMPLATES: AppTemplate[] = [
  {
    id: 'activepieces',
    name: 'Activepieces',
    tagline: 'No-code workflow automation, an open-source Zapier alternative',
    category: 'automation',
    icon: 'lucide:workflow',
    website: 'https://www.activepieces.com',
    version: '0.91.2',
    generate: {
      'encryption-key': { format: 'hex', length: 32 },
      'jwt-secret': { format: 'hex', length: 64 },
    },
    imageHealthcheck: ['activepieces'],
    heavyReason: 'The app and its flow worker share one container that wants about 1 GB of RAM',
    notes: [
      'Runs the app and the flow worker in one container (AP_CONTAINER_TYPE=WORKER_AND_APP). Flow code runs unsandboxed, so only let people you trust build flows.',
    ],
    postDeploy: [
      'Open the URL and sign up. The first account becomes the platform admin.',
      'Create a flow from a template, or pick a trigger and add steps.',
    ],
    yaml: `version: 1
app: activepieces
services:
  activepieces:
    image: ghcr.io/activepieces/activepieces:0.91.2
    port: 80
    memory: 1gb
    env:
      AP_ENVIRONMENT: prod
      AP_FRONTEND_URL: \${{ app.url }}
      AP_DB_TYPE: POSTGRES
      AP_POSTGRES_URL: \${{ db.url }}
      AP_REDIS_URL: \${{ cache.url }}
      AP_ENCRYPTION_KEY: \${{ secrets.encryption-key }}
      AP_JWT_SECRET: \${{ secrets.jwt-secret }}
      AP_EXECUTION_MODE: UNSANDBOXED
      AP_CONTAINER_TYPE: WORKER_AND_APP
      AP_QUEUE_UI_ENABLED: "false"
      AP_TELEMETRY_ENABLED: "false"
      AP_WEBHOOK_TIMEOUT_SECONDS: "30"
      AP_FLOW_TIMEOUT_SECONDS: "600"
    volumes:
      cache: /usr/src/app/cache
resources:
  db:
    type: postgres
    database: activepieces
  cache:
    type: cache
    memory: 64mb
`,
  },
];
