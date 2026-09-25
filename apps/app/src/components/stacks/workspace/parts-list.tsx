import * as React from 'react';
import type { InvService } from '@swarmy/core';
import { CalmRow, RowList, STATUS_WORD } from '@/components/calm';
import { shortImage, stackTone } from '@/components/apps/app-words';
import { STATUS_TONE } from '@/components/canvas/stack-aggregates';
import { serviceRole } from '@/components/canvas/service-role';

/** The phone's "How it is built": the parts as rows (a canvas needs a wider screen). */
export function PartsList({ services, onOpen }: { services: InvService[]; onOpen: (id: string) => void }): React.JSX.Element {
  return (
    <RowList label="Parts">
      {services.map((s) => {
        const tone = stackTone(STATUS_TONE[s.status]);
        return (
          <CalmRow
            key={s.id}
            tone={tone}
            name={s.name}
            sub={<span className="font-sans text-[12.5px]">{serviceRole(s)}</span>}
            tech={`×${s.replicas.running}/${s.replicas.desired} · ${shortImage(s.image)}`}
            word={STATUS_WORD[tone]}
            onClick={() => onOpen(s.id)}
            className="max-sm:[&>span:nth-child(2)]:w-auto max-sm:[&>span:nth-child(2)]:min-w-0 max-sm:[&>span:nth-child(2)]:flex-1"
          />
        );
      })}
    </RowList>
  );
}
