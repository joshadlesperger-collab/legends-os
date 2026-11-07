import env from '@next/env';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
env.loadEnvConfig(process.cwd());
const root = 'artifacts/model-benchmark';
const hash = data => createHash('sha256').update(data).digest('hex');
const q = JSON.parse(readFileSync('artifacts/card-orchestrator/state.json'));
const selection = [
  ['base', 'LOS-3370573cffc97d8df6'], ['parallel', 'LOS-60410520996dda134c'],
  ['low-serial', 'LOS-5800451438316f3be4'], ['weak-evidence', 'LOS-a838ff8251a734499d'],
  ['previously-mispriced', 'LOS-cd21bce0d1312ad9af'],
];
const cards = selection.map(([category, id]) => {
  const card = q.cards[id];
  const photos = card.input.photos.map(photo => {
    const archived = Object.values(q.photoArchives).flatMap(a => a.files ?? []).find(f => f.sha256 === photo.sha256 && existsSync(f.destination));
    const path = existsSync(photo.path) ? photo.path : archived?.destination;
    return { ...photo, resolvedPath: path ?? null, verified: path ? hash(readFileSync(path)) === photo.sha256 : false };
  });
  return { category, id, sourceDigest: hash(JSON.stringify(card)), identity: card.jobs.identity.result.identity, photos,
    source: card, pricingStatus: card.jobs.pricing.state, pricingPolicy: card.jobs.pricing.result?.projection?.policyVersion ?? null };
});
writeFileSync(`${root}/selected-cards.json`, JSON.stringify({ schema: 1, cards }, null, 2));
const recovered = JSON.parse(readFileSync('artifacts/knowledge-graph/recovered-records.json'));
const hashes = new Set(cards.flatMap(c => c.photos.map(p => p.sha256)));
const inventory = recovered.tables.inventory.filter(row => hashes.has(row.front_hash?.toLowerCase()));
const keys = inventory.map(row => row.card_id);
const evidence = recovered.tables.evidence_summaries.filter(row => keys.includes(row.card_id));
const recommendations = recovered.tables.price_recommendations.filter(row => keys.includes(row.card_id));
const sourceKeys = [...keys, ...inventory.map(r => r.variant_id), ...evidence.map(r => r.evidence_id), ...recommendations.map(r => r.recommendation_id)];
const client = new PrismaClient({ log: [] });
let database;
try {
  const rows = await client.knowledgeLegacyRecord.findMany({ where: { sourceKey: { in: sourceKeys } }, select: { id: true, sourceKey: true, sourceTable: true, raw: true }, orderBy: { id: 'asc' } });
  const counts = await Promise.all([client.knowledgeObservation.count(), client.knowledgeVariant.count()]);
  database = { accessible: true, scopedRows: rows.length, digest: hash(JSON.stringify(rows)), observationCount: counts[0], variantCount: counts[1],
    selectedInventory: keys.map(key => ({ key, present: rows.some(row => row.sourceTable === 'inventory' && row.sourceKey === key) })) };
} catch (error) { database = { accessible: false, verified: false, databaseConfigured: Boolean(process.env.DATABASE_URL), errorType: error?.constructor?.name, errorCode: typeof error?.code === 'string' ? error.code : null, legacyDelegateAvailable: Boolean(client.knowledgeLegacyRecord), blocker: 'Read-only database verification failed; no migration or database write attempted.' }; }
finally { await client.$disconnect(); }
const preservation = { capturedAt: new Date().toISOString(), queueCards: Object.keys(q.cards).length,
  selectedIds: cards.map(c => c.id), localRecoveryMatches: inventory.length, database,
  files: ['artifacts/card-orchestrator/state.json', 'artifacts/knowledge-graph/recovered-records.json', 'data/card-catalog/topps-chrome-basketball-2025-26.json'].map(path => ({ path, sha256: hash(readFileSync(path)) })),
  allSelectedPhotosVerified: cards.every(c => c.photos.every(p => p.verified)) };
const output = process.argv.includes('--after') ? 'persistence-after.json' : 'persistence-before.json';
writeFileSync(`${root}/${output}`, JSON.stringify(preservation, null, 2));
console.log(JSON.stringify(preservation));
