/**
 * Demo stand-in for the controller's route-password sealing
 * (packages/trpc ingress-basic-auth.ts): a new password is swapped for a
 * vault reference and dropped. Demo mode keeps no password, just as the real
 * `swarmy.ingress.routes` label never does.
 */
interface DemoPasswordUser {
  username: string;
  passwordSecret?: string;
  password?: string;
}

let sealed = 0;

function demoRef(): string {
  sealed += 1;
  return `rpw_${sealed.toString(16).padStart(24, '0')}`;
}

export function sealDemoPasswords<P extends { basicAuth?: { users: DemoPasswordUser[] } }>(p: P | undefined): P | undefined {
  if (!p?.basicAuth) return p;
  const users = p.basicAuth.users.map((u) => ({ username: u.username, passwordSecret: u.password ? demoRef() : (u.passwordSecret ?? demoRef()) }));
  return { ...p, basicAuth: { users } };
}
