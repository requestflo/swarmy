/**
 * S3 object storage: an S3 SDK (or boto3 / aws-sdk with S3 or AWS_* settings),
 * an S3 client in the code, Active Storage on S3, or a MinIO-style store in
 * compose. Becomes a private bucket on the org's own object storage; the
 * address arrives by binding, the keys by attach (never the app's own names).
 */
import { RESERVED_NAMES } from '../bindings';
import { unitNameOf } from './files';
import type { ScanCtx } from './context';
import { depWords, names } from './detect-data';
import { found, imageMatch } from './signals';
import type { Detection } from './types';

const S3_STRONG = ['@aws-sdk/client-s3', '@aws-sdk/lib-storage', 'minio', 'aws-sdk-s3', 'github.com/aws/aws-sdk-go-v2/service/s3', 'github.com/minio/minio-go/v7', 'league/flysystem-aws-s3-v3'];
const S3_WEAK = ['aws-sdk', 'boto3', 'aws/aws-sdk-php'];
const S3_VAR = /^(AWS_)?S3_[A-Z0-9_]+$|_BUCKET(_NAME)?$|^AWS_ENDPOINT_URL_S3$/;
/** AWS credentials or region: S3 only next to an AWS SDK (SES and friends use them too). */
const AWS_VAR = /^AWS_[A-Z0-9_]+$/;
const S3_IMAGE = /^(minio\/minio|bitnami\/minio|quay\.io\/minio\/minio|dxflrs\/garage|chrislusf\/seaweedfs|localstack\/localstack|adobe\/s3mock)(:|@|$)/;

function strongWords(name: string): string {
  if (name === 'minio' || name.includes('minio-go')) return 'uses the MinIO client';
  if (name.startsWith('league/')) return 'uses Flysystem’s S3 adapter';
  return name === 'aws-sdk-s3' ? 'uses the aws-sdk-s3 gem' : `uses the AWS S3 SDK (${depWords(name)})`;
}

export function detectBucket(c: ScanCtx, taken: Set<string>): Detection | null {
  const strong = c.dep(...S3_STRONG);
  const weak = c.dep(...S3_WEAK);
  const vars = [...c.dotenv.filter((e) => S3_VAR.test(e.name)), ...c.reads.filter((r) => S3_VAR.test(r.name))];
  const aws = [...c.dotenv.filter((e) => AWS_VAR.test(e.name)), ...c.reads.filter((r) => AWS_VAR.test(r.name))];
  const code = c.grep(/(S3Client\(|new AWS\.S3\(|(?:client|resource)\(\s*['"]s3['"])/)[0];
  const image = imageMatch(c.compose, S3_IMAGE);
  const storage = c.find('config/storage.yml', /^\s*service\s*:\s*['"]?S3\b/);
  const s3Vars = vars.some((v) => /^(AWS_)?S3_/.test(v.name));
  if (!strong && !code && !image && !storage && !(weak && (vars.length || aws.length)) && !s3Vars) return null;
  const bucketVar = c.dotenv.find((e) => /BUCKET/.test(e.name) && e.value && !e.value.startsWith('$'));
  const fromValue = bucketVar ? unitNameOf(bucketVar.value) : null;
  const name = fromValue && !taken.has(fromValue) && !(RESERVED_NAMES as readonly string[]).includes(fromValue) ? fromValue : 'files';
  // Keys are never the app's own names: swarmy injects S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY_FILE.
  const env = names(vars.filter((v) => !/(ACCESS_KEY|SECRET|_KEY_ID)/.test(v.name)));
  const setting = vars[0] ?? aws[0];
  return {
    id: 'bucket',
    kind: 'bucket',
    name,
    maps: `resources.${name}`,
    label: 'S3 object storage',
    why: 'A private bucket on your own object storage. Its address and keys arrive at deploy — the secret key as a file, never in git.',
    ...found(c.dir, [
      { ev: strong?.ev, says: strongWords(strong?.name ?? '') },
      { ev: code?.ev, says: 'creates an S3 client' },
      { ev: storage?.ev, says: 'stores Active Storage files on S3' },
      { ev: image?.image?.ev, says: `runs ${image?.image?.value} as ${image?.name}` },
      { ev: weak && setting ? weak.ev : undefined, says: `uses ${weak?.name} with ${setting && AWS_VAR.test(setting.name) && !S3_VAR.test(setting.name) ? 'AWS_* settings' : 'S3 settings'}` },
      { ev: bucketVar?.ev, says: `sets ${bucketVar?.name}` },
      { ev: setting?.ev, says: `${setting && c.dotenv.includes(setting) ? 'sets' : 'reads'} ${setting?.name}` },
    ]),
    env: env.length ? env : ['S3_ENDPOINT', 'S3_BUCKET'],
  };
}
