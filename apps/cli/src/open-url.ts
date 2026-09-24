/** Open a URL in the default browser. False when there is no way to (headless box). */
export async function openUrl(url: string): Promise<boolean> {
  if (!/^https?:\/\//.test(url)) return false;
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : Bun.which('xdg-open')
          ? ['xdg-open', url]
          : null;
  if (!cmd) return false;
  try {
    const p = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}
