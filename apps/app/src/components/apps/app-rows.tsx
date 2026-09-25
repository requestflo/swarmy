import * as React from 'react';
import { CalmRow, RowList } from '@/components/calm';
import type { AppItem } from './use-apps';

/** Apps as flat Calm rows: dot · name/address · plain sentence · tech (Controls) · status word. */
export function AppRows({ apps, label = 'Apps' }: { apps: AppItem[]; label?: string }): React.JSX.Element {
  return (
    <RowList label={label}>
      {apps.map((a) => (
        <CalmRow
          key={a.name}
          to="/stacks/$name"
          params={{ name: a.name }}
          tone={a.words.tone}
          name={a.name}
          sub={
            <>
              {/* CalmRow hides the sentence below sm; on a phone it takes the address line. */}
              <span className="font-sans text-[12.5px] sm:hidden">{a.words.say}</span>
              <span className="hidden sm:inline">{a.host ?? (a.stat.system ? 'managed by swarmy' : '')}</span>
            </>
          }
          say={a.words.say}
          tech={a.words.tech}
          word={a.words.word}
          // Phone: let the name column take the room the hidden sentence leaves.
          className="max-sm:[&>span:nth-child(2)]:w-auto max-sm:[&>span:nth-child(2)]:min-w-0 max-sm:[&>span:nth-child(2)]:flex-1"
        />
      ))}
    </RowList>
  );
}
