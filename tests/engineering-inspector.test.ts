import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectorPreflight,INSPECTOR_SYSTEM} from '../lib/engineering-inspector.ts';
test('inspector requires credential, existing ledger and reviewed bound',()=>{
 for(const key of ['configured','ledgerExists','boundsExists'] as const){const input={configured:true,ledgerExists:true,boundsExists:true,[key]:false};assert.equal(inspectorPreflight(input).ready,false);}
 assert.equal(inspectorPreflight({configured:true,ledgerExists:true,boundsExists:true}).ready,true);
});
test('inspection is advisory rather than execution authority',()=>{
 assert.match(INSPECTOR_SYSTEM,/untrusted evidence/);assert.match(INSPECTOR_SYSTEM,/cannot execute tools/);
});
