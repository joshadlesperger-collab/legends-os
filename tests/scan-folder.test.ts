import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeScanFolder} from '../lib/scan-folder.ts';
test('front/back files count once; unknown filenames stay unmatched',()=>{const r=summarizeScanFolder([{path:'box/card_front.jpg',hash:'a'},{path:'box/card_back.jpg',hash:'b'},{path:'other.jpg',hash:'c'}],'named');assert.equal(r.pairedCards,1);assert.equal(r.unmatchedImages,1)});
test('identical files excluded but never claimed to be physical inventory',()=>{const r=summarizeScanFolder([{path:'one.jpg',hash:'a'},{path:'copy.jpg',hash:'a'}],'fronts-only');assert.equal(r.pairedCards,1);assert.equal(r.duplicateFiles,1)});
test('alternating requires explicit mode; default never divides arbitrary images by two',()=>{const files=[{path:'1.jpg',hash:'1'},{path:'2.jpg',hash:'2'},{path:'3.jpg',hash:'3'}];assert.equal(summarizeScanFolder(files,'named').pairedCards,0);const r=summarizeScanFolder(files,'alternating');assert.equal(r.pairedCards,1);assert.equal(r.unmatchedImages,1)});
