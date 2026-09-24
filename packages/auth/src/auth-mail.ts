/**
 * Better Auth's mail — address verification, password reset and magic links —
 * sent through swarmy's email service when the host wires a sender
 * (`authRegistry.configure({ sendEmail })`, apps/api email.ts). With no sender
 * the options are simply absent, exactly as before (links are logged).
 *
 * Placeholder addresses (`*.swarmy.invalid`, identity.ts) are never mailed.
 */
import { isPlaceholderEmail } from './identity';

export interface AuthMail {
  to: string;
  subject: string;
  text: string;
}

/** Resolves true when the mail was handed to the MTA. Never throws. */
export type SendAuthEmail = (mail: AuthMail) => Promise<boolean>;

export function verificationMail(to: string, url: string): AuthMail {
  return {
    to,
    subject: 'Confirm your email address for swarmy',
    text:
      `Confirm this address to finish setting up your swarmy account:\n\n${url}\n\n` +
      'The link expires in an hour. If you did not sign up, ignore this email.',
  };
}

export function resetPasswordMail(to: string, url: string): AuthMail {
  return {
    to,
    subject: 'Reset your swarmy password',
    text: `Someone asked to reset the password for this account. Choose a new one here:\n\n${url}\n\nIf it was not you, ignore this email — your password stays the same.`,
  };
}

export function magicLinkMail(to: string, url: string): AuthMail {
  return {
    to,
    subject: 'Your swarmy sign-in link',
    text: `Sign in to swarmy with this link:\n\n${url}\n\nIt works once and expires in a few minutes.`,
  };
}

async function deliver(send: SendAuthEmail, mail: AuthMail): Promise<void> {
  if (isPlaceholderEmail(mail.to)) return;
  await send(mail).catch(() => false);
}

/** A magic-link sender over the email service. */
export function magicLinkMailer(send: SendAuthEmail) {
  return async ({ email, url }: { email: string; url: string; token: string }) => deliver(send, magicLinkMail(email, url));
}

/**
 * The `emailAndPassword` + `emailVerification` options to spread into the
 * Better Auth config. Verification mail goes out on sign-up and when the
 * login page asks again; a verified address is what lets an email-named
 * invite admit a password account (`inviteAdmits`).
 */
export function authMailOptions(send: SendAuthEmail | undefined) {
  if (!send) return { emailAndPassword: { enabled: true, autoSignIn: true } };
  return {
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => deliver(send, resetPasswordMail(user.email, url)),
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => deliver(send, verificationMail(user.email, url)),
    },
  };
}
