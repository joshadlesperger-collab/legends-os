/** Seller default for owned raw inventory; never apply to sold-comp evidence. */
export const CONDITION_DEFAULT_POLICY = {
  defaultCondition: 'Near mint or better',
  askRoutineConfirmation: false,
  instruction: 'Default owned raw cards to Near mint or better without batch or per-card confirmation. Preserve explicit condition overrides, graded status, visible-damage exceptions and seller holds. This is a seller default, not proof of inspection or pack-fresh provenance; never default sold-comp conditions.',
} as const;

export function ownedCardCondition(value: string | null | undefined): string {
  return !value?.trim() || value.trim() === 'Not specified'
    ? CONDITION_DEFAULT_POLICY.defaultCondition : value.trim();
}
