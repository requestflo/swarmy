import * as React from 'react';
import { BlueprintParamsInput, type BlueprintMetaView, type BlueprintSize } from '@swarmy/core';
import { useOnlineNodeCount } from '@/lib/use-online-node-count';
import { defaultSizeForNodes } from '@/components/blueprints/blueprint-option-fields';
import { defaultAppName } from '@/components/blueprints/template-words';

export type Options = Record<string, string | boolean>;

/**
 * The Configure page's fields: name, own domain (behind a switch), size and
 * the template's options. `params` is the validated deploy input, or null
 * while something doesn't validate (the field says what).
 */
export function useConfigureForm(meta: BlueprintMetaView, initialName?: string) {
  const online = useOnlineNodeCount();
  const [name, setName] = React.useState(() => initialName ?? defaultAppName(meta));
  const [ownDomain, setOwnDomain] = React.useState(false);
  const [domain, setDomain] = React.useState('');
  const [size, setSizeRaw] = React.useState<BlueprintSize | null>(null);
  // The server it's pinned to (Pick a server); null = Automatic.
  const [node, setNode] = React.useState<string | null>(null);
  const [options, setOptions] = React.useState<Options>(() => Object.fromEntries(meta.options.map((o) => [o.key, o.defaultValue])));
  // Follow the fleet's size until the person picks one.
  const effectiveSize = size ?? defaultSizeForNodes(online);
  const setOption = (key: string, value: string | boolean): void => setOptions((o) => ({ ...o, [key]: value }));

  const nameCheck = BlueprintParamsInput.shape.name.safeParse(name);
  const wantDomain = ownDomain && meta.supportsDomain;
  const domainCheck = wantDomain ? BlueprintParamsInput.shape.domain.safeParse(domain.trim() || undefined) : null;
  const nameError = nameCheck.success ? null : name ? 'Lowercase letters, digits and dashes, up to 30.' : 'Give it a name.';
  const domainError = !wantDomain ? null : !domain.trim() ? 'Type the domain, or switch back to the automatic address.' : domainCheck?.success ? null : 'That doesn’t look like a domain.';
  const params = React.useMemo(() => {
    if (nameError || domainError) return null;
    const r = BlueprintParamsInput.safeParse({ name, size: effectiveSize, options, ...(wantDomain ? { domain: domain.trim() } : {}), ...(node ? { node } : {}) });
    return r.success ? r.data : null;
  }, [name, effectiveSize, options, wantDomain, domain, nameError, domainError, node]);

  return {
    name, setName, nameError,
    ownDomain: wantDomain, setOwnDomain, domain, setDomain, domainError,
    size: effectiveSize, setSize: (s: BlueprintSize) => setSizeRaw(s), online,
    options, setOption,
    node, setNode,
    params,
  };
}

export type ConfigureFormState = ReturnType<typeof useConfigureForm>;
