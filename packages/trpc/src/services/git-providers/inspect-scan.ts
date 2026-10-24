/**
 * git.inspect's source scan (the New app wizard's "Here's what we found"):
 * pick up to SOURCE_SCAN_MAX_FILES app source files under the folder, fetch
 * exactly those blobs in one batch (a partial clone would otherwise fetch them
 * one by one), and grep each for SOURCE_SCAN_PATTERN — only the matching
 * lines leave the container, with their real line numbers. PURE: the shell
 * lines and the parser are golden-tested; any failure inside just means
 * fewer hits, never a failed read.
 */
import {
  SOURCE_PATH_RE,
  SOURCE_SCAN_MAX_FILES,
  SOURCE_SCAN_MAX_HITS,
  SOURCE_SCAN_MAX_HITS_PER_FILE,
  SOURCE_SCAN_PATTERN,
  SOURCE_SKIP_RE,
} from '@swarmy/app-config';

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Grep output budget per hit line (bytes). */
export const SCAN_LINE_BYTES = 200;

export interface SourceScan {
  /** Every source file grepped (hits or not). */
  files: string[];
  hits: Array<{ file: string; line: number; text: string }>;
}

/** Shell lines that append the scan to the inspect program (needs `$H` and `$W`). */
export function renderScanLines(dir: string): string[] {
  const d = dir.replace(/^\.?\/*|\/+$/g, '');
  const spec = d ? ` -- ${shq(d)}` : '';
  const budget = SOURCE_SCAN_MAX_FILES + SOURCE_SCAN_MAX_HITS;
  return [
    '{',
    // Paths with whitespace or backslashes are skipped: they can't round-trip the tab-separated markers.
    `  git ls-tree -r --name-only "$H"${spec} 2>/dev/null | grep -E ${shq(SOURCE_PATH_RE)} | grep -vE ${shq(SOURCE_SKIP_RE)} | grep -v '[[:space:]\\\\]' | head -n ${SOURCE_SCAN_MAX_FILES} > "$W/.scan" || true`,
    '  if [ -s "$W/.scan" ]; then',
    '    xargs git ls-tree "$H" -- < "$W/.scan" | awk \'{print $3}\' | git -c fetch.negotiationAlgorithm=noop fetch -q --no-tags --no-write-fetch-head --recurse-submodules=no --filter=blob:none --stdin origin 2>/dev/null || true',
    '    while IFS= read -r f; do',
    `      printf 'SWARMY_SCANNED\\t%s\\n' "$f"`,
    `      git cat-file blob "$H:$f" 2>/dev/null | head -c 65536 | grep -n -E ${shq(SOURCE_SCAN_PATTERN)} | head -n ${SOURCE_SCAN_MAX_HITS_PER_FILE} | cut -c1-${SCAN_LINE_BYTES} | awk -v f="$f" '{ i = index($0, ":"); printf "SWARMY_HIT\\t%s\\t%s\\t%s\\n", f, substr($0, 1, i - 1), substr($0, i + 1) }'`,
    `    done < "$W/.scan" | head -n ${budget}`,
    '  fi',
    '} || true',
  ];
}

/** Read the scan's marker lines back out of the inspect output. */
export function parseScanLines(lines: string[]): SourceScan | undefined {
  const files: string[] = [];
  const hits: SourceScan['hits'] = [];
  for (const l of lines) {
    if (l.startsWith('SWARMY_SCANNED\t')) files.push(l.slice('SWARMY_SCANNED\t'.length));
    else if (l.startsWith('SWARMY_HIT\t')) {
      const [, file, line, ...rest] = l.split('\t');
      const n = Number(line);
      if (file && Number.isInteger(n) && n > 0 && hits.length < SOURCE_SCAN_MAX_HITS) hits.push({ file, line: n, text: rest.join('\t') });
    }
  }
  return files.length ? { files, hits } : undefined;
}
