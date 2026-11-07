import { z } from 'zod';
import { consolidationKey, type V2State } from './card-processing-v2.ts';

export const v2BatchConsolidationSchema = z.object({
  version: z.literal(1), scope: z.literal('selected-batch-only'),
  physicalCards: z.number().int().nonnegative(), draftGroups: z.number().int().nonnegative(),
  groups: z.array(z.object({
    groupId: z.string(), cardIds: z.array(z.string()).min(1),
    captureIds: z.array(z.string()).min(1), quantity: z.number().int().positive(),
  }).strict()),
}).strict();

/** Local grouping only. No provider/inventory calls, photo changes or listing writes.
 * Existing identity keys preserve frozen ownership; numbered copies stay separate.
 */
export function planV2BatchConsolidation(state: V2State, selectedCardIds: readonly string[]) {
  if (new Set(selectedCardIds).size !== selectedCardIds.length || selectedCardIds.some(id => !state.cards[id]))
    throw Error('Exact unique selected batch card IDs required');
  const captures = new Set<string>();
  const groups = new Map<string, { groupId: string; cardIds: string[]; captureIds: string[]; quantity: number }>();
  for (const id of [...selectedCardIds].sort()) {
    const card = state.cards[id];
    if (!card.identity || card.issues.length || card.draftId || card.inventoryArchive || card.draftArchive
      || card.activeQuantityOperationId || !['identified', 'consolidated', 'prepared'].includes(card.stage)) continue;
    if (captures.has(card.captureId)) throw Error('Copied capture cannot increase batch quantity');
    captures.add(card.captureId);
    const groupId = consolidationKey(card.stage==='identified'?{...card,consolidationVersion:2}:card);
    const group = groups.get(groupId) ?? { groupId, cardIds: [], captureIds: [], quantity: 0 };
    group.cardIds.push(id); group.captureIds.push(card.captureId); group.quantity++;
    groups.set(groupId, group);
  }
  return v2BatchConsolidationSchema.parse({ version: 1, scope: 'selected-batch-only',
    physicalCards: captures.size, draftGroups: groups.size,
    groups: Array.from(groups.values()).sort((a, b) => a.groupId.localeCompare(b.groupId)),
  });
}
