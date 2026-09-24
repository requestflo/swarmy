import type { AppTemplate } from '../types';

export const AI_TEMPLATES: AppTemplate[] = [
  {
    id: 'open-webui',
    name: 'Open WebUI',
    tagline: 'ChatGPT-style web interface for OpenAI-compatible APIs and Ollama',
    category: 'ai',
    icon: 'lucide:message-square',
    website: 'https://openwebui.com',
    version: '0.11.4',
    generate: { 'secret-key': { format: 'alnum', length: 48 } },
    imageHealthcheck: ['open-webui'],
    heavyReason: 'Runs a local embedding model in-process for document chat (RAG); wants about 1.5 GB of RAM',
    postDeploy: [
      'Open <url> and sign up: the first account becomes the admin (later sign-ups wait for approval).',
      'Add a model provider under Admin Panel → Settings → Connections: an OpenAI-compatible API key, or the URL of an Ollama server.',
    ],
    notes: [
      'No model runs here: connect an API provider or a separate Ollama server. Ollama in another swarmy app needs a connect between the two apps.',
      'Users, chats and settings live in the managed Postgres database; uploaded documents and the vector index live on the data volume.',
    ],
    yaml: `version: 1
app: open-webui
services:
  open-webui:
    image: ghcr.io/open-webui/open-webui:v0.11.4
    port: 8080
    memory: 1536mb
    env:
      WEBUI_URL: \${{ app.url }}
      WEBUI_SECRET_KEY: \${{ secrets.secret-key }}
      DATABASE_URL: \${{ db.url }}
    volumes:
      data: /app/backend/data
resources:
  db:
    type: postgres
    database: openwebui
`,
  },
  {
    id: 'ollama',
    name: 'Ollama',
    tagline: 'Run open-weight language models on your own server behind an API',
    category: 'ai',
    icon: 'ollama',
    website: 'https://ollama.com',
    version: '0.34.4',
    heavyReason: 'Models are loaded into RAM and run on the CPU; even a small 3B model needs 3 to 4 GB',
    postDeploy: [
      'Pull a model: open a terminal in the ollama service and run ollama pull llama3.2:3b (or pick one sized for your node from ollama.com/library).',
      'Test it with curl <url>/api/generate -d \'{"model":"llama3.2:3b","prompt":"Hello"}\', or point Open WebUI and other clients at <url>.',
    ],
    notes: [
      'API only: there is no web UI. Pair it with Open WebUI or another client.',
      'There is no GPU, so inference runs on the CPU and is slow. Pick small, quantised models that fit in the service memory limit.',
      'The Ollama API has no authentication. Anyone who can reach the URL can run and pull models, so restrict the route (IP allow-list) or keep it on an internal address.',
    ],
    yaml: `version: 1
app: ollama
services:
  ollama:
    image: ollama/ollama:0.34.4
    port: 11434
    memory: 4gb
    volumes:
      models: /root/.ollama
    healthcheck:
      command: ["ollama", "list"]
      interval: 30s
      timeout: 10s
      start_period: 30s
`,
  },
  {
    id: 'flowise',
    name: 'Flowise',
    tagline: 'Build LLM agents and chat flows with a drag-and-drop editor',
    category: 'ai',
    icon: 'lucide:workflow',
    website: 'https://flowiseai.com',
    version: '3.1.4',
    generate: {
      'encryption-key': { format: 'alnum', length: 32 },
      'jwt-auth-secret': { format: 'hex', length: 64 },
      'jwt-refresh-secret': { format: 'hex', length: 64 },
      'session-secret': { format: 'hex', length: 64 },
      'token-hash-secret': { format: 'hex', length: 64 },
    },
    heavyReason: 'Node + LangChain runtime (with Chromium for web scraping) wants about 768 MB plus its Postgres database',
    postDeploy: [
      'Open <url> and create the admin account on first visit.',
      'Add your model provider credentials under Credentials, then build a chatflow or agentflow.',
    ],
    notes: [
      'Flows, credentials (encrypted with a generated key) and chat history live in the managed Postgres database; uploads and logs live on the data volume.',
      'Email invites and password resets need SMTP_* env vars.',
    ],
    yaml: `version: 1
app: flowise
services:
  flowise:
    image: flowiseai/flowise:3.1.4
    port: 3000
    memory: 768mb
    env:
      PORT: "3000"
      APP_URL: \${{ app.url }}
      NUMBER_OF_PROXIES: "1"
      DATABASE_TYPE: postgres
      DATABASE_HOST: \${{ db.host }}
      DATABASE_PORT: \${{ db.port }}
      DATABASE_NAME: \${{ db.database }}
      DATABASE_USER: \${{ db.user }}
      DATABASE_PASSWORD: \${{ db.password }}
      DATABASE_SSL: "false"
      FLOWISE_SECRETKEY_OVERWRITE: \${{ secrets.encryption-key }}
      JWT_AUTH_TOKEN_SECRET: \${{ secrets.jwt-auth-secret }}
      JWT_REFRESH_TOKEN_SECRET: \${{ secrets.jwt-refresh-secret }}
      EXPRESS_SESSION_SECRET: \${{ secrets.session-secret }}
      TOKEN_HASH_SECRET: \${{ secrets.token-hash-secret }}
      DISABLE_FLOWISE_TELEMETRY: "true"
    volumes:
      data: /home/node
    healthcheck:
      path: /api/v1/ping
      interval: 30s
      timeout: 5s
      start_period: 120s
resources:
  db:
    type: postgres
    database: flowise
`,
  },
  {
    id: 'anythingllm',
    name: 'AnythingLLM',
    tagline: 'Chat with your documents using any LLM, with agents and workspaces',
    category: 'ai',
    icon: 'lucide:brain',
    website: 'https://anythingllm.com',
    version: '1.16.2',
    generate: {
      'auth-token': { format: 'alnum', length: 24 },
      'jwt-secret': { format: 'alnum', length: 48 },
      'sig-key': { format: 'alnum', length: 48 },
      'sig-salt': { format: 'alnum', length: 48 },
    },
    reveal: ['AnythingLLM password: ${{ secrets.auth-token }} (shown once, so save it now)'],
    imageHealthcheck: ['anythingllm'],
    heavyReason: 'Runs its document collector, built-in embedder and LanceDB vector store in one container; wants about 1.5 GB of RAM',
    postDeploy: [
      'Open <url> and enter the password shown above.',
      'Pick an LLM provider (an API key, or the URL of an Ollama server) in the onboarding, then create a workspace and upload documents.',
      'For multiple users, enable multi-user mode under Settings → Security.',
    ],
    notes: [
      'Everything (SQLite database, documents, vector index) lives on the storage volume, so back that volume up.',
      'Scraping websites into a workspace uses Chromium, which may fail without the SYS_ADMIN capability that swarmy does not grant. Uploading files works normally.',
    ],
    yaml: `version: 1
app: anythingllm
services:
  anythingllm:
    image: mintplexlabs/anythingllm:1.16.2
    port: 3001
    memory: 1536mb
    env:
      SERVER_PORT: "3001"
      STORAGE_DIR: /app/server/storage
      AUTH_TOKEN: \${{ secrets.auth-token }}
      JWT_SECRET: \${{ secrets.jwt-secret }}
      SIG_KEY: \${{ secrets.sig-key }}
      SIG_SALT: \${{ secrets.sig-salt }}
      DISABLE_TELEMETRY: "true"
    volumes:
      storage: /app/server/storage
`,
  },
  {
    id: 'librechat',
    name: 'LibreChat',
    tagline: 'Multi-provider AI chat with agents, presets and conversation search',
    category: 'ai',
    icon: 'lucide:messages-square',
    website: 'https://www.librechat.ai',
    version: '0.8.7',
    generate: {
      'creds-key': { format: 'hex', length: 64 },
      'creds-iv': { format: 'hex', length: 32 },
      'jwt-secret': { format: 'hex', length: 64 },
      'jwt-refresh-secret': { format: 'hex', length: 64 },
      'meili-key': { format: 'alnum', length: 40 },
    },
    heavyReason: 'LibreChat plus its bundled MongoDB and Meilisearch want about 1.4 GB of RAM',
    postDeploy: [
      'Open <url> and register: the first account becomes the admin.',
      'Choose a provider in the model menu and paste your own API key (OpenAI, Anthropic and Google are set to user-provided keys).',
      'To stop public sign-ups afterwards, set ALLOW_REGISTRATION to false and redeploy.',
    ],
    notes: [
      'LibreChat needs MongoDB, so it runs its own MongoDB (swarmy has no managed MongoDB). That database is not in swarmy backups; back up the mongodb volume.',
      'Meilisearch (conversation search) is bundled too; its index is rebuilt from MongoDB if lost.',
      'No librechat.yaml is mounted, so LibreChat runs on its defaults. Custom endpoints and fine-grained settings need that file, which one-click templates cannot supply; server-wide API keys can be added as env vars (OPENAI_API_KEY and so on).',
      'The document-chat RAG API is not included.',
    ],
    yaml: `version: 1
app: librechat
services:
  librechat:
    image: ghcr.io/danny-avila/librechat:v0.8.7
    port: 3080
    memory: 640mb
    env:
      HOST: 0.0.0.0
      PORT: "3080"
      DOMAIN_CLIENT: \${{ app.url }}
      DOMAIN_SERVER: \${{ app.url }}
      TRUST_PROXY: "1"
      NO_INDEX: "true"
      MONGO_URI: mongodb://mongodb:27017/LibreChat
      SEARCH: "true"
      MEILI_HOST: http://meilisearch:7700
      MEILI_NO_ANALYTICS: "true"
      MEILI_MASTER_KEY: \${{ secrets.meili-key }}
      CREDS_KEY: \${{ secrets.creds-key }}
      CREDS_IV: \${{ secrets.creds-iv }}
      JWT_SECRET: \${{ secrets.jwt-secret }}
      JWT_REFRESH_SECRET: \${{ secrets.jwt-refresh-secret }}
      ALLOW_EMAIL_LOGIN: "true"
      ALLOW_REGISTRATION: "true"
      ALLOW_SOCIAL_LOGIN: "false"
      ALLOW_SOCIAL_REGISTRATION: "false"
      ALLOW_UNVERIFIED_EMAIL_LOGIN: "true"
      OPENAI_API_KEY: user_provided
      ANTHROPIC_API_KEY: user_provided
      GOOGLE_KEY: user_provided
    volumes:
      uploads: /app/uploads
      images: /app/client/public/images
      logs: /app/logs
    healthcheck:
      path: /health
      interval: 30s
      timeout: 5s
      start_period: 120s
  mongodb:
    image: mongo:8.0.32
    command: ["--noauth", "--wiredTigerCacheSizeGB", "0.25"]
    memory: 512mb
    volumes:
      mongodb: /data/db
    healthcheck:
      command: ["mongosh", "--quiet", "--eval", "db.adminCommand('ping')"]
      interval: 15s
      timeout: 10s
      start_period: 30s
  meilisearch:
    image: getmeili/meilisearch:v1.35.1
    memory: 256mb
    env:
      MEILI_ENV: production
      MEILI_NO_ANALYTICS: "true"
      MEILI_MASTER_KEY: \${{ secrets.meili-key }}
    volumes:
      meili: /meili_data
    healthcheck:
      command: ["curl", "-fsS", "-o", "/dev/null", "http://127.0.0.1:7700/health"]
      interval: 30s
      timeout: 5s
      start_period: 30s
`,
  },
];
