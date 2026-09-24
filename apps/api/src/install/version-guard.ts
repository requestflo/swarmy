/**
 * The installer version is interpolated into shell scripts served to
 * `curl | sh` as root (loader comment line, installer path, installer header).
 * It arrives from a query string / path parameter, URL-decoded, so a `%0A`
 * would start a new shell line in a script the REAL controller serves. Only a
 * plain version token is ever rendered.
 */
export const SAFE_INSTALL_VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

export class UnsafeInstallVersionError extends Error {
  constructor(version: string) {
    super(`refusing to render an installer for version ${JSON.stringify(version.slice(0, 80))}`);
    this.name = 'UnsafeInstallVersionError';
  }
}

export function assertSafeInstallVersion(version: string): string {
  if (!SAFE_INSTALL_VERSION.test(version)) throw new UnsafeInstallVersionError(version);
  return version;
}
