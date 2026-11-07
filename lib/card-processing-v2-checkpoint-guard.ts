/** Preserve journal-owned row multiplicity and exact JSON bytes in one linear pass.
 * Non-journal legacy rows remain the domain callback's responsibility. */
export function assertV2JournalRowsUnchanged(rows:ReadonlyArray<{id:string}>,journalRows:ReadonlyMap<string,string>){
 const seen=new Set<string>();
 for(const row of rows){const expected=journalRows.get(row.id);if(expected===undefined)continue;
  if(seen.has(row.id)||JSON.stringify(row)!==expected)throw Error('Use the timing journal to change journal-owned spans');seen.add(row.id);
 }
 if(seen.size!==journalRows.size)throw Error('Use the timing journal to change journal-owned spans');
}
