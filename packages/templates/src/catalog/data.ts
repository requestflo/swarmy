import type { AppTemplate } from '../types';

const ADMIN_EMAIL_OPTION = {
  key: 'admin_email',
  label: 'Admin email',
  kind: 'string' as const,
  help: 'The email you sign in with.',
  placeholder: 'you@example.com',
  defaultValue: 'admin@example.com',
};

export const DATA_TEMPLATES: AppTemplate[] = [
  {
    id: 'pgadmin',
    name: 'pgAdmin',
    tagline: 'Web admin and query tool for PostgreSQL databases',
    category: 'data',
    icon: 'postgresql',
    website: 'https://www.pgadmin.org',
    version: '9.18',
    options: [ADMIN_EMAIL_OPTION],
    generate: { 'admin-password': { format: 'alnum', length: 24 } },
    reveal: ['pgAdmin login: your admin email / ${{ secrets.admin-password }} (shown once, so save it now)'],
    notes: ['The admin account is created on first start only; change the email or password later in pgAdmin itself.'],
    postDeploy: [
      'Sign in with your admin email and the password shown above.',
      'Add a server (Object → Register → Server) with the host, port and password from a swarmy database’s Connect panel.',
    ],
    yaml: `version: 1
app: pgadmin
services:
  pgadmin:
    image: dpage/pgadmin4:9.18
    port: 80
    memory: 384mb
    env:
      PGADMIN_DEFAULT_EMAIL: "[[opt.admin_email]]"
      PGADMIN_DEFAULT_PASSWORD_FILE: /run/secrets/admin-password
      PGADMIN_DISABLE_POSTFIX: "true"
    secrets: [admin-password]
    volumes:
      data: /var/lib/pgadmin
    healthcheck:
      path: /misc/ping
      interval: 30s
      timeout: 5s
      start_period: 60s
`,
  },
  {
    id: 'adminer',
    name: 'Adminer',
    tagline: 'Single-page database manager for Postgres, MySQL, SQLite and more',
    category: 'data',
    icon: 'adminer',
    website: 'https://www.adminer.org',
    version: '6.1.0',
    notes: ['Adminer has no accounts of its own: its login form connects to whatever database you name, so keep the URL private or put it behind access control.'],
    postDeploy: [
      'Open the URL, pick the database system, and enter the host, user and password of the database you want to manage.',
    ],
    yaml: `version: 1
app: adminer
services:
  adminer:
    image: adminer:6.1.0
    port: 8080
    memory: 128mb
    healthcheck:
      path: /
      interval: 30s
      timeout: 5s
      start_period: 10s
`,
  },
  {
    id: 'metabase',
    name: 'Metabase',
    tagline: 'Business intelligence dashboards and questions anyone can ask',
    category: 'data',
    icon: 'metabase',
    website: 'https://www.metabase.com',
    version: '0.63.18',
    generate: { 'encryption-key': { format: 'alnum', length: 32 } },
    heavyReason: 'Java app server; Metabase wants 1 GB of RAM or more',
    notes: ['Metabase keeps its own settings and saved questions in a swarmy-managed Postgres; your data sources are added separately.'],
    postDeploy: [
      'Open the URL and complete the setup wizard to create the admin account (first start takes a few minutes).',
      'Add a database to analyse (Admin → Databases), e.g. a swarmy Postgres via its read-only URL.',
    ],
    yaml: `version: 1
app: metabase
services:
  metabase:
    image: metabase/metabase:v0.63.18
    port: 3000
    memory: 1gb
    env:
      MB_SITE_URL: \${{ app.url }}
      MB_DB_TYPE: postgres
      MB_DB_HOST: \${{ db.host }}
      MB_DB_PORT: \${{ db.port }}
      MB_DB_DBNAME: \${{ db.database }}
      MB_DB_USER: \${{ db.user }}
      MB_DB_PASS: \${{ db.password }}
      MB_ENCRYPTION_SECRET_KEY: \${{ secrets.encryption-key }}
      MB_ANON_TRACKING_ENABLED: "false"
      JAVA_OPTS: -XX:MaxRAMPercentage=70
    healthcheck:
      path: /api/health
      interval: 30s
      timeout: 10s
      start_period: 300s
resources:
  db:
    type: postgres
    database: metabase
`,
  },
  {
    id: 'nocodb',
    name: 'NocoDB',
    tagline: 'Turn a database into a collaborative spreadsheet, an open Airtable alternative',
    category: 'data',
    icon: 'lucide:table',
    website: 'https://nocodb.com',
    version: '2026.09.0',
    options: [ADMIN_EMAIL_OPTION],
    generate: {
      'jwt-secret': { format: 'alnum', length: 48 },
      'admin-password': { format: 'alnum', length: 24 },
    },
    reveal: ['NocoDB super admin login: your admin email / ${{ secrets.admin-password }} (shown once, so save it now)'],
    postDeploy: [
      'Sign in with your admin email and the password shown above.',
      'Create a base, or connect an existing database as a data source.',
    ],
    yaml: `version: 1
app: nocodb
services:
  nocodb:
    image: nocodb/nocodb:2026.09.0
    port: 8080
    memory: 512mb
    env:
      NC_DB: pg://\${{ db.host }}:\${{ db.port }}?u=\${{ db.user }}&p=\${{ db.password }}&d=\${{ db.database }}
      NC_AUTH_JWT_SECRET: \${{ secrets.jwt-secret }}
      NC_PUBLIC_URL: \${{ app.url }}
      NC_ADMIN_EMAIL: "[[opt.admin_email]]"
      NC_ADMIN_PASSWORD: \${{ secrets.admin-password }}
      NC_DISABLE_TELE: "true"
    volumes:
      data: /usr/app/data
    healthcheck:
      path: /api/v1/health
      interval: 30s
      timeout: 5s
      start_period: 60s
resources:
  db:
    type: postgres
    database: nocodb
`,
  },
  {
    id: 'baserow',
    name: 'Baserow',
    tagline: 'No-code database and app builder, an open Airtable alternative',
    category: 'data',
    icon: 'baserow',
    website: 'https://baserow.io',
    version: '2.3.4',
    generate: {
      'secret-key': { format: 'alnum', length: 50 },
      'jwt-key': { format: 'alnum', length: 50 },
    },
    imageHealthcheck: ['baserow'],
    heavyReason: 'The all-in-one image runs the web frontend, API and background workers together; about 1.5 GB of RAM',
    notes: ['Uploaded files are kept on the container volume, not in object storage.'],
    postDeploy: [
      'Open the URL and sign up; the first account becomes the instance admin (first start runs migrations and takes a few minutes).',
      'Set up email under Admin → Settings, or invites and password resets will not send.',
    ],
    yaml: `version: 1
app: baserow
services:
  baserow:
    image: baserow/baserow:2.3.4
    port: 80
    memory: 1536mb
    env:
      BASEROW_PUBLIC_URL: \${{ app.url }}
      DATABASE_HOST: \${{ db.host }}
      DATABASE_PORT: \${{ db.port }}
      DATABASE_NAME: \${{ db.database }}
      DATABASE_USER: \${{ db.user }}
      DATABASE_PASSWORD: \${{ db.password }}
      REDIS_HOST: \${{ cache.host }}
      REDIS_PORT: \${{ cache.port }}
      REDIS_PASSWORD: \${{ cache.password }}
      SECRET_KEY: \${{ secrets.secret-key }}
      BASEROW_JWT_SIGNING_KEY: \${{ secrets.jwt-key }}
      BASEROW_AMOUNT_OF_WORKERS: "1"
      BASEROW_RUN_MINIMAL: "yes"
    volumes:
      data: /baserow/data
resources:
  db:
    type: postgres
    database: baserow
  cache:
    type: cache
    memory: 64mb
`,
  },
  {
    id: 'cloudbeaver',
    name: 'CloudBeaver',
    tagline: 'DBeaver in the browser: a web SQL client for many databases',
    category: 'data',
    icon: 'dbeaver',
    website: 'https://dbeaver.com/cloudbeaver',
    version: '26.2.1',
    generate: { 'admin-password': { format: 'alnum', length: 24 } },
    // CloudBeaver's password policy needs mixed case and a digit, so the
    // generated password gets a fixed `Aa1` suffix (see env + reveal).
    reveal: ['CloudBeaver admin login: cbadmin / ${{ secrets.admin-password }}Aa1 (shown once, so save it now)'],
    heavyReason: 'Java app server; wants about 1 GB of RAM',
    notes: ['CloudBeaver keeps its own users and saved connections in an embedded H2 database on the workspace volume.'],
    postDeploy: [
      'Sign in as cbadmin with the password shown above.',
      'Add a connection (New Connection) with the host, port and password from a swarmy database’s Connect panel.',
    ],
    yaml: `version: 1
app: cloudbeaver
services:
  cloudbeaver:
    image: dbeaver/cloudbeaver:26.2.1
    port: 8978
    memory: 1gb
    env:
      CB_SERVER_NAME: CloudBeaver
      CB_SERVER_URL: \${{ app.url }}
      CB_ADMIN_NAME: cbadmin
      CB_ADMIN_PASSWORD: \${{ secrets.admin-password }}Aa1
      JAVA_OPTS: -XX:MaxRAMPercentage=70
    volumes:
      workspace: /opt/cloudbeaver/workspace
    healthcheck:
      command: ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8978 && printf 'GET /status HTTP/1.0\\\\r\\\\nHost: localhost\\\\r\\\\n\\\\r\\\\n' >&3 && grep -q -m1 '^HTTP/1.1 200' <&3"]
      interval: 30s
      timeout: 10s
      start_period: 120s
`,
  },
];
