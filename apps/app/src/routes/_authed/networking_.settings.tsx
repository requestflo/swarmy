import { createFileRoute } from '@tanstack/react-router';
import { MeshSettingsPage } from '@/components/networking/mesh-settings-page';

/** Network › Private network › Mesh settings: the driver, every peer, laptop grants. */
export const Route = createFileRoute('/_authed/networking_/settings')({
  component: MeshSettingsPage,
});
