import { checkOverlayMtu } from '@swarmy/core';
import type { DomainResolvers } from '../types';

/**
 * `mesh.mtu` (mirror of `MeshMtuView`, mesh-mtu.service.ts) for Mesh settings:
 * the demo cluster's servers report wt0 at 1280, and storefront's network plus
 * Docker's ingress network were made before the mesh at Docker's default, so
 * the page shows "Networks are too big for the mesh". Run through the real
 * check so the numbers are the product's own.
 */
const CHECK = checkOverlayMtu({
  iface: 'wt0',
  linkMtu: 1280,
  overlays: [
    { name: 'ingress', encrypted: false, attachable: false, managed: false, ingress: true },
    { name: 'storefront_default', encrypted: false, attachable: true, managed: true, ingress: false, stack: 'storefront' },
    { name: 'swarmy', mtu: 1280, encrypted: true, attachable: true, managed: true, ingress: false },
    { name: 'swarmy-control', mtu: 1280, encrypted: true, attachable: true, managed: true, ingress: false },
    { name: 'data_default', mtu: 1280, encrypted: false, attachable: true, managed: true, ingress: false, stack: 'data' },
  ],
});

export const meshMtu: DomainResolvers = {
  handlers: {
    'mesh.mtu': () => ({
      ...CHECK,
      services: {
        ingress: [],
        storefront_default: ['storefront_api', 'storefront_cdn-edge', 'storefront_checkout', 'storefront_web'],
      },
      reporting: 4,
    }),
  },
};
