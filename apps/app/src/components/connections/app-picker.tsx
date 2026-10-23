import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';

/** Which app the tab is about. The choice lives in the URL (`?app=`), so it can be linked to. */
export function AppPicker({ apps, value }: { apps: string[]; value: string | undefined }): React.JSX.Element | null {
  const navigate = useNavigate();
  const id = React.useId();
  if (apps.length === 0) return null;
  const options = [...new Set([...(value ? [value] : []), ...apps])].sort();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-muted-foreground text-[13px] font-semibold">
        App
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => void navigate({ to: '/network/connections', search: { app: e.target.value } })}
        className="border-border bg-background h-9 min-w-40 rounded-[10px] border px-2.5 font-mono text-[13px] pointer-coarse:min-h-11"
      >
        {options.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
    </div>
  );
}
