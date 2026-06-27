import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { StarIcon } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  Input,
  Popover,
  PopoverAnchor,
  PopoverContent,
  cn,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface ImagePickerProps {
  /** Full `name:tag` value. */
  value: string;
  onChange: (value: string) => void;
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function splitImage(value: string): { name: string; tag: string } {
  const at = value.split('@')[0] ?? value;
  const idx = at.lastIndexOf(':');
  if (idx <= 0 || at.slice(idx + 1).includes('/')) return { name: at, tag: '' };
  return { name: at.slice(0, idx), tag: at.slice(idx + 1) };
}

/**
 * Docker Hub image+tag autocomplete. Best-effort: if the proxy returns nothing
 * it stays a plain text input. Type a name -> name suggestions; once a name is
 * set, the tag field offers tag suggestions.
 */
export function ImagePicker({ value, onChange }: ImagePickerProps): React.JSX.Element {
  const trpc = useTRPC();
  const { name, tag } = splitImage(value);
  const [nameOpen, setNameOpen] = React.useState(false);
  const [tagOpen, setTagOpen] = React.useState(false);

  const debouncedName = useDebounced(name, 250);
  const search = useQuery({
    ...trpc.images.search.queryOptions({ query: debouncedName }),
    enabled: nameOpen && debouncedName.trim().length >= 2,
  });
  const tags = useQuery({
    ...trpc.images.tags.queryOptions({ image: name }),
    enabled: tagOpen && name.trim().length >= 1,
  });

  const setName = (next: string): void => onChange(tag ? `${next}:${tag}` : next);
  const setTag = (next: string): void => onChange(next ? `${name}:${next}` : name);

  const suggestions = search.data ?? [];
  const tagSuggestions = tags.data ?? [];

  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-start">
      <Popover open={nameOpen && suggestions.length > 0} onOpenChange={setNameOpen}>
        <PopoverAnchor asChild>
          <Input
            placeholder="nginx"
            className="font-mono"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={() => setNameOpen(true)}
            onBlur={() => setTimeout(() => setNameOpen(false), 150)}
          />
        </PopoverAnchor>
        <PopoverContent
          className="w-[--radix-popover-trigger-width] p-0"
          align="start"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Command shouldFilter={false}>
            <CommandList>
              <CommandEmpty>No images.</CommandEmpty>
              <CommandGroup>
                {suggestions.map((s) => (
                  <CommandItem
                    key={s.name}
                    value={s.name}
                    onSelect={() => {
                      setName(s.name);
                      setNameOpen(false);
                    }}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="truncate">
                      <span className="font-mono">{s.name}</span>
                      {s.official && <span className="text-status-online mono-label ml-2">official</span>}
                    </span>
                    <span className="text-muted-foreground mono-label flex shrink-0 items-center gap-1">
                      <StarIcon className="size-3" /> {s.stars}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <Popover open={tagOpen && tagSuggestions.length > 0} onOpenChange={setTagOpen}>
        <PopoverAnchor asChild>
          <Input
            placeholder="latest"
            className={cn('font-mono sm:w-40')}
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            onFocus={() => setTagOpen(true)}
            onBlur={() => setTimeout(() => setTagOpen(false), 150)}
          />
        </PopoverAnchor>
        <PopoverContent
          className="w-48 p-0"
          align="end"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Command shouldFilter={false}>
            <CommandList>
              <CommandEmpty>No tags.</CommandEmpty>
              <CommandGroup>
                {tagSuggestions.map((t) => (
                  <CommandItem
                    key={t.name}
                    value={t.name}
                    onSelect={() => {
                      setTag(t.name);
                      setTagOpen(false);
                    }}
                  >
                    <span className="font-mono">{t.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
