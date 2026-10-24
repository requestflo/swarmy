import { describe, expect, it } from 'bun:test';
import { meshSkipReason } from './mesh-startup';

describe('meshSkipReason: a skipped mesh-first join is never silent', () => {
  it('nothing to say when the node may join and has a key', () => {
    expect(meshSkipReason({ allowMesh: true, hasSetupKey: true })).toBeNull();
  });

  it('a configured key the opt-out makes the agent ignore is called out, with the fix', () => {
    const r = meshSkipReason({ allowMesh: false, hasSetupKey: true });
    expect(r).toContain('setup key is ignored');
    expect(r).toContain('SWARMY_ALLOW_MESH=true');
  });

  it('a plain opt-out says mesh is disabled', () => {
    expect(meshSkipReason({ allowMesh: false, hasSetupKey: false })).toBe(
      'mesh disabled on this node (SWARMY_ALLOW_MESH=false): not joining a mesh',
    );
  });

  it('no key says so and points at the repair one-liner', () => {
    const r = meshSkipReason({ allowMesh: true, hasSetupKey: false });
    expect(r).toContain('no SWARMY_MESH_SETUP_KEY configured');
    expect(r).toContain('re-run the install one-liner');
  });
});
