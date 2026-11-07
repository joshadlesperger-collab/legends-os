import env from '@next/env';
import { writeFileSync } from 'node:fs';
env.loadEnvConfig(process.cwd());
// Metadata requests only: no generation, automatic retries or response-body logging.
const probes = [
  ['openai', 'OPENAI_API_KEY', 'https://api.openai.com/v1/models', key => ({ Authorization: `Bearer ${key}` })],
  ['anthropic', 'ANTHROPIC_API_KEY', 'https://api.anthropic.com/v1/models', key => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' })],
  ['xai', 'XAI_API_KEY', 'https://api.x.ai/v1/models', key => ({ Authorization: `Bearer ${key}` })],
  ['google', 'GOOGLE_GENERATIVE_AI_API_KEY', 'https://generativelanguage.googleapis.com/v1beta/models', key => ({ 'x-goog-api-key': key })],
];
const results = await Promise.all(probes.map(async ([provider, keyEnv, url, headers]) => {
  if (!process.env[keyEnv]?.trim()) return { provider, keyEnv, configured: false };
  try {
    const response = await fetch(url, { headers: headers(process.env[keyEnv]), signal: AbortSignal.timeout(15000), redirect: 'error' });
    return { provider, keyEnv, configured: true, httpStatus: response.status, credentialVerified: response.ok };
  } catch { return { provider, keyEnv, configured: true, credentialVerified: false, blocker: 'Metadata request failed; credential validity unverified.' }; }
}));
writeFileSync('artifacts/model-benchmark/credentials.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
