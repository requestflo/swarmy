import * as React from 'react';
import { useTheme } from 'next-themes';
import { MoonIcon, SunIcon } from 'lucide-react';

/**
 * Light / Dark on the map (board 22): one quiet button that flips the app's
 * theme with the same setter as Preferences and the user menu (next-themes,
 * saved in this browser). It names the theme it switches to.
 */
export function ThemeFlip(): React.JSX.Element {
  const { resolvedTheme, setTheme } = useTheme();
  const toLight = resolvedTheme === 'dark';
  const Icon = toLight ? SunIcon : MoonIcon;
  return (
    <button
      type="button"
      onClick={() => setTheme(toLight ? 'light' : 'dark')}
      aria-label={`Switch to ${toLight ? 'light' : 'dark'} theme`}
      className="border-border bg-card text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex h-9 items-center gap-1.5 rounded-[10px] border px-3 text-[13px] font-semibold outline-none focus-visible:ring-2 pointer-coarse:min-h-11"
    >
      <Icon aria-hidden className="size-3.5" />
      {toLight ? 'Light' : 'Dark'}
    </button>
  );
}
