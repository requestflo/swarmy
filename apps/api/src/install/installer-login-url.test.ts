import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** QA-044: the https dashboard is THE login; the direct port is documented as node-local. */
const SCRIPT = path.resolve(import.meta.dir, '../../../../scripts/install-swarmy.sh');

describe('installer login URL', () => {
  const script = readFileSync(SCRIPT, 'utf8');
  const finalize = script.slice(script.indexOf('finalize() {'), script.indexOf('# With a mesh, the bootstrap line'));

  it('prints the https dashboard first and labels the direct URL node-local', () => {
    expect(finalize.indexOf("'  Dashboard:  https://%s")).toBeGreaterThan(-1);
    expect(finalize.indexOf("'  Dashboard:  https://%s")).toBeLessThan(finalize.indexOf("'  Direct:     %s"));
    expect(finalize).toContain('$(direct_url_note)');
  });

  it('direct_url_note says it only answers on the controller node and moves with it', () => {
    const r = Bun.spawnSync(['bash', '-c', '. "$0"; direct_url_note', SCRIPT], { stdout: 'pipe' });
    const note = r.stdout.toString();
    expect(note).toContain('node-local');
    expect(note).toContain('changes if the controller moves');
  }, 30_000);
});
