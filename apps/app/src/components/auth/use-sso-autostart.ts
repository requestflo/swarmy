import * as React from 'react';
import { startSignIn, type SignInOption } from './sign-in-options';

/**
 * `/login?sso=<providerId>` — the SSO admin's test link: once the sign-in
 * options load, start that provider's sign-in, once. Answers an error to show
 * when the provider isn't offered (off, or not set up) or could not start.
 */
export function useSsoAutostart(sso: string | undefined, options: SignInOption[] | undefined, callbackURL: string): string | null {
  const started = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!sso || !options || started.current) return;
    started.current = true;
    const option = options.find((o) => o.kind === 'sso' && o.id === sso);
    if (!option) {
      setError(`Company sign-in "${sso}" isn't turned on here yet.`);
      return;
    }
    void startSignIn(option, callbackURL).then((e) => e && setError(e));
  }, [sso, options, callbackURL]);
  return error;
}
