import { useTheme } from 'next-themes';
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@swarmy/ui';

const OPTIONS = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
  { value: 'system', label: 'System', icon: MonitorIcon },
] as const;

/** Appearance picker — drop into a user dropdown menu. */
export function ThemeMenuItems(): React.JSX.Element {
  const { theme, setTheme } = useTheme();
  return (
    <>
      <DropdownMenuLabel className="text-muted-foreground text-xs">Appearance</DropdownMenuLabel>
      {OPTIONS.map((o) => (
        <DropdownMenuItem
          key={o.value}
          onSelect={(e) => {
            e.preventDefault();
            setTheme(o.value);
          }}
        >
          <o.icon className="size-4" />
          {o.label}
          {theme === o.value && <CheckIcon className="ml-auto size-4" />}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
    </>
  );
}
