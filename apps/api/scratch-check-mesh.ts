import { prisma } from '@swarmy/db';
const nodes = await prisma.node.findMany();
for (const n of nodes) console.log(Object.keys(n).join(','));
for (const n of nodes) console.log(n.id, n.hostname, n.online, n.lastSeenAt);
process.exit(0);
