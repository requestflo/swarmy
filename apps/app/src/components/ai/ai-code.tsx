import * as React from 'react';
import { CodeView, toYaml } from '@/components/calm';

/** The gateway as code: an app's `ai:` key, and the OpenAI-compatible call it makes. */
export function AiCode({ gatewayUrl }: { gatewayUrl: string }): React.JSX.Element {
  const yaml = `# swarmy.yaml — let this app call the gateway\n${toYaml({ ai: { models: ['smart', 'embed'], budget: '5/day', rpm: 120, services: ['web', 'worker'] } })}\n\n# each bound service gets OPENAI_BASE_URL, ANTHROPIC_BASE_URL, AI_GATEWAY_URL\n# and its own key as OPENAI_API_KEY / ANTHROPIC_API_KEY (secrets)`;
  const call = [
    `curl ${gatewayUrl || '<gateway>'}/chat/completions \\`,
    '  -H "Authorization: Bearer $OPENAI_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '${JSON.stringify({ model: 'smart', messages: [{ role: 'user', content: 'Hello' }] })}'`,
  ].join('\n');
  const sdk = [
    "import OpenAI from 'openai';",
    '',
    '// OPENAI_BASE_URL and OPENAI_API_KEY are already set in the app',
    'const ai = new OpenAI();',
    "const r = await ai.chat.completions.create({ model: 'fast', messages: [{ role: 'user', content: 'Hi' }] });",
  ].join('\n');
  return (
    <CodeView
      tabs={[
        { label: 'swarmy.yaml', code: yaml },
        { label: 'HTTP', code: call },
        { label: 'SDK', code: sdk },
      ]}
      source="yaml"
    />
  );
}
