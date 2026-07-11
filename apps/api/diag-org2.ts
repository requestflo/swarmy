import { prisma } from '@swarmy/db';
const nodes = await prisma.node.findMany({ where: { orgId: 'hRQ9kThFFZIy8sN891ZF1FCxy3zEFirr' }, select: { id: true, name: true, hostname: true, joinTokenId: true, createdAt: true } });
console.log('NODES:', JSON.stringify(nodes, null, 2));
const tokens = await prisma.joinToken.findMany({ where: { orgId: 'hRQ9kThFFZIy8sN891ZF1FCxy3zEFirr' }, select: { id: true, label: true, uses: true, maxUses: true, createdAt: true } });
console.log('TOKENS:', JSON.stringify(tokens, null, 2));
process.exit(0);
