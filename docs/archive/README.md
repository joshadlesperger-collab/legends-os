# Superseded decision archive

Preserve replaced decisions here when their original source text and replacement are verified. Do not delete history or treat archived instructions as active policy. Git tracks changes after commit; this directory makes supersession explicit to readers.

## Record format

- Decision ID and descriptive title
- Status: superseded (or historical/unresolved when replacement authority is not established)
- Original decision date and source reference
- Original wording or a clearly labeled summary
- Effective scope
- Superseded date and replacement decision ID / current policy link
- Reason for change
- Affected code, records, and recalculation/migration status

Use filenames such as `YYYY-MM-DD-descriptive-decision.md`. Never invent a decision date or source. If chronology is uncertain, retain it in the unresolved index until verified.

## Maintenance

1. Establish the replacement's authority and scope.
2. Preserve the old decision and source; add a replacement link.
3. Update the current policy, `DECISIONS.md`, and `docs/CHANGELOG.md` together.
4. Identify affected runtime rules and saved valuations; record whether implementation and recalculation are complete.
5. Verify behavior. Archiving text alone does not update runtime behavior.

No historical decisions have been archived yet: original policy sources still need reconciliation.
