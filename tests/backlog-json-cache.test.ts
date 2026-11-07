import test from "node:test";
import assert from "node:assert/strict";
import {backlogJsonCache} from "../lib/backlog-json-cache.ts";

test("parsed source reuse compares complete text and freezes nested values",()=>{
 const parse=backlogJsonCache();
 const first=parse("file",'{"nested":{"value":1}}') as {nested:{value:number}};
 assert.equal(parse("file",'{"nested":{"value":1}}'),first);
 assert.throws(()=>{first.nested.value=3;},TypeError);
 assert.deepEqual(parse("file",'{"nested":{"value":2}}'),{nested:{value:2}});
 assert.throws(()=>parse("file",'{bad'),SyntaxError);
 assert.deepEqual(parse("file",'{"nested":{"value":1}}'),first);
 assert.notEqual(parse("other-root",'{"nested":{"value":1}}'),first);
});
test("entry count, total text and per-entry limits evict or bypass without changing data",()=>{
 const parse=backlogJsonCache(30,20,2);
 const a=parse("a",'{"v":1}');parse("b",'{"v":2}');
 assert.equal(parse("a",'{"v":1}'),a);parse("c",'{"v":3}');
 const b=parse("b",'{"v":2}');assert.notEqual(parse("a",'{"v":1}'),a);
 assert.deepEqual(b,{v:2});
 const large='{"value":"'+"x".repeat(40)+'"}';assert.notEqual(parse("large",large),parse("large",large));
 const bounded=backlogJsonCache(15,15,10),one=bounded("a",'{"v":1}');bounded("b",'{"v":2}');bounded("c",'{"v":3}');
 assert.notEqual(bounded("a",'{"v":1}'),one);
});
