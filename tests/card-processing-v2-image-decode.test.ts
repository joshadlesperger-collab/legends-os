import test from 'node:test';import assert from 'node:assert/strict';import sharp from 'sharp';
import {isV2Heic,v2DecodableImage} from '../lib/card-processing-v2-image-decode.ts';
test('actual magic identifies HEIC only; extension or corrupt JPEG does not enable converter fallback',async()=>{
 const heic=Buffer.alloc(24);heic.writeUInt32BE(24);heic.write('ftypheic',4);heic.write('mif1heix',16);assert.equal(isV2Heic(heic),true);
 const jpeg=Buffer.from([255,216,0,1]);assert.equal(isV2Heic(jpeg),false);assert.deepEqual(await v2DecodableImage(jpeg),jpeg);await assert.rejects(sharp(await v2DecodableImage(jpeg)).jpeg().toBuffer());
 const avif=Buffer.from(heic);avif.write('avif',8);avif.write('avifavif',16);assert.equal(isV2Heic(avif),false);heic.writeUInt32BE(999);assert.equal(isV2Heic(heic),false);
});
test('normal JPEG bytes and ownership hash input remain unchanged',async()=>{const bytes=await sharp({create:{width:20,height:30,channels:3,background:'blue'}}).jpeg().toBuffer(),before=Buffer.from(bytes);assert.deepEqual(await v2DecodableImage(bytes),before);assert.deepEqual(bytes,before);});
test('oversized originals and corrupt HEIC fail before any provider or file writes',async()=>{await assert.rejects(v2DecodableImage(Buffer.alloc(35000001)),/Bounded/);const corrupt=Buffer.alloc(24);corrupt.writeUInt32BE(24);corrupt.write('ftypheic',4);await assert.rejects(v2DecodableImage(corrupt));});
