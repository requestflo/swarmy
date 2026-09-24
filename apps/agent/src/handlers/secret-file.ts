/**
 * Put a small secret into a created-but-not-started container as a 0600 file
 * (on one of its volumes), so it never rides `docker run -e` — env persists in
 * `docker inspect` / config.v2.json (security review H15/H16). Used for NetBird
 * setup keys: the client reads them via NB_SETUP_KEY_FILE.
 *
 * `putArchive` on a created container writes through its mounts, so the file
 * lands on the named volume, not in the image layer.
 */
import type Docker from 'dockerode';

/** A one-file ustar archive (512-byte header + data, padded, two zero blocks). Pure. */
export function singleFileTar(name: string, contents: string, mode = 0o600): Buffer {
  const data = Buffer.from(contents, 'utf8');
  const header = Buffer.alloc(512, 0);
  const put = (s: string, off: number, len: number) => header.write(s.slice(0, len), off, len, 'ascii');
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(oct(mode, 8), 100, 8);
  put(oct(0, 8), 108, 8); // uid root
  put(oct(0, 8), 116, 8); // gid root
  put(oct(data.length, 12), 124, 12);
  put(oct(Math.floor(Date.now() / 1000), 12), 136, 12);
  header.fill(' ', 148, 156); // checksum placeholder
  put('0', 156, 1); // regular file
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of header) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([header, data, pad, Buffer.alloc(1024, 0)]);
}

/** Write `dir/name` (0600, root) into a created container before it starts. */
export async function putSecretFile(container: Docker.Container, dir: string, name: string, contents: string): Promise<void> {
  await container.putArchive(singleFileTar(name, contents), { path: dir });
}
