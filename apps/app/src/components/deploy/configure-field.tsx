import * as React from 'react';

/** A labelled Configure field: label, the control, then a help or error line. */
export function ConfigureField({
  label,
  htmlFor,
  help,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  help?: React.ReactNode;
  error?: string | null;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-[13.5px] font-semibold">
          {label}
        </label>
      ) : (
        <span className="text-[13.5px] font-semibold">{label}</span>
      )}
      {children}
      {error ? (
        <p role="alert" className="text-tone-bad text-xs">
          {error}
        </p>
      ) : help ? (
        <div className="text-muted-foreground text-xs leading-relaxed">{help}</div>
      ) : null}
    </div>
  );
}
