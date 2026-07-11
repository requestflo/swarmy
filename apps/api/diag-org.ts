import { prisma } from '@swarmy/db';
import { JOIN_TOKEN_PREFIX } from '@swarmy/core';
import { mintSetupKeyForOrg, type OrgContext } from '@swarmy/trpc';
import { createHash, randomBytes } from 'node:crypto';

const ORG_ID = 'hRQ9kThFFZIy8sN891ZF1FCxy3zEFirr';
const label = process.argv[2] ?? 'local-vm';

const hashToken = (raw: string): string => createHash('sha256').update(raw).digest('hex');

const meshCtx = { db: prisma, activeOrgId: ORG_ID } as unknown as OrgContext;
const mesh = await mintSetupKeyForOrg(meshCtx);

const prefix = randomBytes(4).toString('hex');
const secret = randomBytes(32).toString('base64url');
const token = `${JOIN_TOKEN_PREFIX}_${prefix}_${secret}`;
const maxUses = mesh ? 1 : 100;
await prisma.joinToken.create({
  data: {
    orgId: ORG_ID,
    tokenHash: hashToken(token),
    tokenPrefix: prefix,
    label,
    maxUses,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  },
});

console.log(`TOKEN=${token}`);
if (mesh) {
  console.log(`MESH_SETUP_KEY=${mesh.setupKey}`);
  console.log(`MESH_MANAGEMENT_URL=${mesh.managementUrl ?? ''}`);
  console.log(`MESH_DRIVER=${mesh.driver}`);
}
process.exit(0);
