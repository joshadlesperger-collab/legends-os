import test from 'node:test';
import assert from 'node:assert/strict';
import {draftFailureContext} from '../lib/engineering-capa.ts';

test('historical live failures cannot masquerade as editable draft repairs',()=>{
  const draft={draftId:'123',state:'saved',verification:{evidence:'retained.json',checks:[{field:'issues.inspected',status:'missing'},{field:'item',status:'pass'}]}};
  const input={cards:{live:{draftLifecycle:draft,exclusion:{disposition:'live',itemId:'456'}},sold:{draftLifecycle:draft,exclusion:{disposition:'sold',itemId:'789'}},unknown:{draftLifecycle:draft}}};
  const before=JSON.stringify(input),result=draftFailureContext(input);
  assert.equal(result.rows.filter(r=>r.classification==='historical-after-inventory-handoff').length,2);
  assert.equal(result.rows.find(r=>r.cardId==='unknown')?.classification,'requires-current-draft-reconciliation');
  assert.deepEqual(result.rows[0].fields,[{field:'issues.inspected',status:'missing'}]);
  assert.equal(JSON.stringify(input),before);
});

test('absence of retained failures does not invent a repair or successful live observation',()=>{
  assert.deepEqual(draftFailureContext({}).rows,[]);
  assert.deepEqual(draftFailureContext({cards:{a:{draftLifecycle:{state:'saved',verification:{checks:[{field:'item',status:'pass'}]}}}}}).rows,[]);
});
