import * as React from 'react';
import { Button, Input, Label } from '@swarmy/ui';
import { CalmPage, CodeView, SayHeader, Section } from '@/components/calm';
import { DeviceRequest } from './device-request';

/** Confirm a `swarmy login` from the CLI: the code, the machine, and what it asks for. */
export function DeviceApproval({ initialCode }: { initialCode: string }): React.JSX.Element {
  const [code, setCode] = React.useState(initialCode);
  const [submitted, setSubmitted] = React.useState(initialCode);
  return (
    <CalmPage crumbs={[{ label: 'Settings', to: '/settings' }, { label: 'API, CLI & MCP', to: '/settings/api-keys' }, { label: 'Approve a sign-in' }]}>
      <div className="mx-auto flex w-full max-w-xl flex-col gap-5">
        <SayHeader
          eyebrow="Sign in a device"
          title={<>Let the CLI in? <em>Only if you just asked.</em></>}
          lede="Approve only if you just ran swarmy login and the code matches your terminal."
        />
        <CodeView title="What asked" tabs={[{ label: 'CLI', code: 'swarmy login --scope read,write\n# → opens this page with the code it printed\nswarmy whoami' }]} source="readonly" />
        {submitted ? (
          <DeviceRequest code={submitted} onReset={() => setSubmitted('')} />
        ) : (
          <Section title="The code from your terminal">
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); setSubmitted(code.trim()); }}>
              <div className="grid min-w-[12rem] flex-1 gap-1.5">
                <Label htmlFor="device-code">Code</Label>
                <Input id="device-code" autoFocus value={code} placeholder="BCDF-GHJK" className="font-mono text-lg tracking-widest uppercase" onChange={(e) => setCode(e.target.value)} />
              </div>
              <Button type="submit" className="pointer-coarse:min-h-11" disabled={code.trim().length < 8}>Continue</Button>
            </form>
          </Section>
        )}
      </div>
    </CalmPage>
  );
}
