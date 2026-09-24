import { describe, expect, it } from 'bun:test';
import { authMailOptions, magicLinkMailer, type AuthMail } from './auth-mail';

describe('Better Auth mail over the email service', () => {
  it('without a sender the config is unchanged (no verification, no reset mail)', () => {
    expect(authMailOptions(undefined)).toEqual({ emailAndPassword: { enabled: true, autoSignIn: true } });
  });

  it('with a sender: verification on sign-up and password reset are mailed', async () => {
    const sent: AuthMail[] = [];
    const o = authMailOptions(async (m) => (sent.push(m), true));
    expect(o.emailVerification?.sendOnSignUp).toBe(true);
    await o.emailVerification!.sendVerificationEmail({ user: { email: 'ada@example.com' }, url: 'https://swarm.test/verify?token=t' });
    await o.emailAndPassword.sendResetPassword!({ user: { email: 'ada@example.com' }, url: 'https://swarm.test/reset?token=r' });
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      ['ada@example.com', 'Confirm your email address for swarmy'],
      ['ada@example.com', 'Reset your swarmy password'],
    ]);
    expect(sent[0]!.text).toContain('https://swarm.test/verify?token=t');
  });

  it('never mails a placeholder address, and a failing sender never throws', async () => {
    const sent: AuthMail[] = [];
    const o = authMailOptions(async (m) => (sent.push(m), true));
    await o.emailVerification!.sendVerificationEmail({ user: { email: 'u_123@users.swarmy.invalid' }, url: 'x' });
    expect(sent).toEqual([]);
    const boom = magicLinkMailer(async () => Promise.reject(new Error('down')));
    await expect(boom({ email: 'a@b.co', url: 'u', token: 't' })).resolves.toBeUndefined();
  });
});
