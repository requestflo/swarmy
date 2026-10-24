import * as React from 'react';
import { XIcon } from 'lucide-react';
import { Button, Input } from '@swarmy/ui';
import { useDepth } from '@/components/calm';
import type { RouteProtection } from '@/components/ingress/protection-model';
import { ProtectionCard } from './protection-card';
import { passwordOff, passwordProblem, passwordSay, passwordUsers, withPasswordUser, withoutPasswordUser } from './password-rules';

/**
 * "Require a password" (board 30): HTTP basic auth at the front door, after
 * the other rules. Switching it on asks for the first username and password;
 * at Controls you can add people, give someone a new password, or take them off.
 */
export function PasswordCard({ protection: p, service, saving, save }: {
  protection: RouteProtection | null;
  service: string;
  saving: boolean;
  save: (next: RouteProtection | null, done?: string) => void;
}): React.JSX.Element {
  const controls = useDepth().depth !== 'summary';
  const users = passwordUsers(p);
  const on = users.length > 0;
  const [adding, setAdding] = React.useState(false);
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [problem, setProblem] = React.useState<string | null>(null);
  const reset = () => {
    setAdding(false);
    setUsername('');
    setPassword('');
    setProblem(null);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const why = passwordProblem(username, password);
    if (why) return setProblem(why);
    const name = username.trim();
    const known = users.some((u) => u.username === name);
    save(withPasswordUser(p, name, password), known ? `New password for ${name}` : on ? `${name} can sign in` : 'Password on');
    reset();
  };
  const showForm = adding || (controls && on);
  return (
    <ProtectionCard
      title="Require a password"
      on={on || adding}
      disabled={saving}
      onToggle={(v) => {
        if (v) setAdding(true);
        else if (adding && !on) reset();
        else save(passwordOff(p), 'Password off');
      }}
      say={passwordSay(p, service)}
      tech={`basic_auth { ${users.map((u) => u.username).join(' ') || '…'} <bcrypt> } · after the other rules · hashes sealed in swarmy’s vault, never on the label`}
    >
      {on && controls ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="People who can sign in">
          {users.map((u) => (
            <li key={u.username} className="bg-muted inline-flex items-center gap-1 rounded-md py-0.5 pr-0.5 pl-2 font-mono text-[12px]">
              {u.username}
              <Button type="button" variant="ghost" size="icon" className="size-6 pointer-coarse:size-11" aria-label={`Take ${u.username} off`} disabled={saving} onClick={() => save(withoutPasswordUser(p, u.username), `${u.username} taken off`)}>
                <XIcon className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {showForm ? (
        <form className="flex flex-col gap-1.5" onSubmit={submit}>
          <Input aria-label="Username" autoComplete="off" value={username} placeholder="Username, e.g. team" onChange={(e) => setUsername(e.target.value)} className="h-8 font-mono text-[12px]" />
          <Input aria-label="Password" type="password" autoComplete="new-password" value={password} placeholder="Password, at least 8 characters" onChange={(e) => setPassword(e.target.value)} className="h-8 font-mono text-[12px]" />
          {problem ? <p role="alert" className="text-tone-bad text-[12px]">{problem}</p> : null}
          <div className="flex justify-end gap-1.5">
            {adding ? <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={saving}>Cancel</Button> : null}
            <Button type="submit" variant="outline" size="sm" disabled={saving}>{on ? 'Save person' : 'Save'}</Button>
          </div>
        </form>
      ) : null}
    </ProtectionCard>
  );
}
