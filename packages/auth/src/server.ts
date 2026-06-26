import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { organization } from 'better-auth/plugins';
import { prisma } from '@swarmy/db';

/**
 * The controller's Better Auth instance. Mounted at `/api/auth/*` by apps/api.
 * Uses the Prisma adapter against the shared schema and the organization plugin
 * (multi-tenant teams own nodes/services/etc.).
 */
export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3001',
  trustedOrigins: [
    process.env.CONTROLLER_PUBLIC_URL ?? 'http://localhost:3001',
    'http://localhost:3003',
  ],
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
  },
  session: {
    cookieCache: { enabled: true, maxAge: 60 },
  },
  plugins: [organization()],
});

export type Auth = typeof auth;
export type Session = Auth['$Infer']['Session'];
export type AuthUser = Auth['$Infer']['Session']['user'];
