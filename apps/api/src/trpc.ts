import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter, createContext } from '@swarmy/trpc';
import { auth } from '@swarmy/auth';
import { prisma } from '@swarmy/db';
import { hub } from './gateway';

export function handleTrpc(req: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => createContext({ headers: req.headers, db: prisma, hub, auth }),
  });
}
