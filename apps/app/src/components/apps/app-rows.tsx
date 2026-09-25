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
          sub={a.host ?? (a.stat.system ? 'managed by swarmy' : undefined)}
          say={a.words.say}
          tech={a.words.tech}
          word={a.words.word}
        />
      ))}
    </RowList>
  );
}
