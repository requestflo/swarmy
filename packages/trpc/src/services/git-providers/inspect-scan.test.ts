import { describe, expect, it } from 'bun:test';
import { parseInspectOutput, renderInspectProgram, validateInspectRequest } from './inspect';
import { parseScanLines, renderScanLines } from './inspect-scan';

const SHA = 'a'.repeat(40);

describe('git.inspect source scan', () => {
  it('lists source files under the folder only, batch-fetches them, greps each', () => {
    const lines = renderScanLines('services/orders');
    expect(lines[1]).toStartWith(`  git ls-tree -r --name-only "$H" -- 'services/orders' 2>/dev/null | grep -E '\\.(ts|tsx|`);
    expect(lines[1]).toContain('node_modules|vendor|dist');
    expect(lines[1]).toEndWith('| head -n 40 > "$W/.scan" || true');
    expect(lines[3]).toContain('fetch -q --no-tags --no-write-fetch-head --recurse-submodules=no --filter=blob:none --stdin origin');
    expect(lines[6]).toContain("| grep -n -E 'DATABASE_URL|POSTGRES|");
    expect(lines[6]).toContain('| head -n 4 | cut -c1-200 |');
    expect(lines.at(-1)).toBe('} || true');
    // The repo root has no pathspec.
    expect(renderScanLines('')[1]).toStartWith('  git ls-tree -r --name-only "$H" 2>/dev/null |');
  });

  it('rides the inspect program before SWARMY_END, only when asked', () => {
    const base = { url: 'https://github.com/n/p.git', ref: 'main', paths: ['swarmy.yaml'] };
    expect(renderInspectProgram(base)).not.toContain('SWARMY_SCANNED');
    const prog = renderInspectProgram({ ...base, scanDir: 'services/orders' }).split('\n');
    expect(prog.at(-1)).toBe('echo SWARMY_END');
    expect(prog.at(-2)).toBe('} || true');
    expect(validateInspectRequest({ ...base, scanDir: '../etc' })).toBe('invalid path "../etc"');
  });

  it('parses scanned files and hits (tabs in code survive), and ignores junk', () => {
    expect(
      parseScanLines([
        'SWARMY_SCANNED\tsrc/queue.ts',
        'SWARMY_HIT\tsrc/queue.ts\t3\tconst r = new Redis(process.env.REDIS_URL);',
        'SWARMY_HIT\tsrc/queue.ts\t7\t\tqueue.add(\tjob)',
        'SWARMY_HIT\tsrc/queue.ts\tnope\tbad',
        'SWARMY_SCANNED\tsrc/empty.ts',
      ]),
    ).toEqual({
      files: ['src/queue.ts', 'src/empty.ts'],
      hits: [
        { file: 'src/queue.ts', line: 3, text: 'const r = new Redis(process.env.REDIS_URL);' },
        { file: 'src/queue.ts', line: 7, text: '\tqueue.add(\tjob)' },
      ],
    });
    expect(parseScanLines(['SWARMY_BEGIN'])).toBeUndefined();
  });

  it('parseInspectOutput carries the scan', () => {
    const out = ['SWARMY_BEGIN', `SWARMY_HEAD ${SHA}`, 'SWARMY_SCANNED\tsrc/db.ts', 'SWARMY_HIT\tsrc/db.ts\t2\tnew Pool()', 'SWARMY_END'].join('\n');
    expect(parseInspectOutput(out, []).scan).toEqual({ files: ['src/db.ts'], hits: [{ file: 'src/db.ts', line: 2, text: 'new Pool()' }] });
  });
});
