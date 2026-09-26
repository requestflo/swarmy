import * as React from 'react';
import type { BlueprintMetaView } from '@swarmy/core';
import { Depth, Tech } from '@/components/calm';
import { BlueprintOptionField, BlueprintSizePicker } from '@/components/blueprints/blueprint-option-fields';
import type { ConfigureFormState } from './use-configure-form';

const PRESET: Record<string, string> = {
  s: 'app replicas=1 · db read replicas=0 · cache 128 MB',
  m: 'app replicas=2 · db read replicas=1 · cache 256 MB',
  l: 'app replicas=3 · db read replicas=2 · cache 1024 MB',
};

/** Controls depth: the size and the template's on/off settings, inline (no "Advanced"). */
export function ConfigureControls({ meta, form }: { meta: BlueprintMetaView; form: ConfigureFormState }): React.JSX.Element {
  const switches = meta.options.filter((o) => o.kind === 'boolean');
  return (
    <Depth at="controls">
      <div className="border-border flex flex-col gap-4 border-t pt-5">
        <BlueprintSizePicker value={form.size} onlineNodes={form.online} onChange={form.setSize} />
        <Tech>{`size=${form.size} · ${PRESET[form.size]}`}</Tech>
        {switches.map((o) => (
          <BlueprintOptionField key={o.key} option={o} value={form.options[o.key]} onChange={(v) => form.setOption(o.key, v)} />
        ))}
      </div>
    </Depth>
  );
}
