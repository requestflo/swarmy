import * as React from 'react';
import { Depth, TONE_TEXT } from '@/components/calm';
import { Fact } from './cert-fact-rows';
import { caaLine, caaTech, type CaaFacts } from './caa-words';

/** The Certificate card's CAA row (board 30): may Let's Encrypt issue for this address? */
export function CaaRow({ caa }: { caa: CaaFacts | null }): React.JSX.Element | null {
  const line = caaLine(caa);
  if (!line) return null;
  const tech = caaTech(caa);
  return (
    <Fact k="CAA">
      <span className={TONE_TEXT[line.tone]}>{line.text}</span>
      {line.note && line.tone !== 'ok' ? <span className="text-muted-foreground block font-sans text-[12px]">{line.note}</span> : null}
      {tech ? (
        <Depth at="controls">
          <span className="text-muted-foreground block text-[11px]">{tech}</span>
        </Depth>
      ) : null}
    </Fact>
  );
}
