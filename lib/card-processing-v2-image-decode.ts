import sharp from 'sharp';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
/** Original bytes remain the ownership/hash authority. Conversion is an in-memory
 * derivative only, using the already installed legacy HEIC converter. */
export function isV2Heic(bytes:Uint8Array){const b=Buffer.from(bytes);if(b.length<16||b.toString('ascii',4,8)!=='ftyp')return false;const size=b.readUInt32BE(0);if(size<16||size>b.length||size>4096)return false;const brands=[b.toString('ascii',8,12)];for(let n=16;n+4<=size;n+=4)brands.push(b.toString('ascii',n,n+4));return brands.some(v=>['heic','heix','hevc','hevx'].includes(v));}
const cache=new Map<string,Promise<Buffer>>();
async function decodeHeic(original:Buffer,root:string):Promise<Buffer>{
 const metadata=await sharp(original,{limitInputPixels:80_000_000}).metadata();
 if(!metadata.width||!metadata.height||metadata.width*metadata.height>80_000_000||(metadata.pages??1)!==1)throw Error('Bounded single-image HEIC required');
 const requireConverter=createRequire(path.join(root,'artifacts','heic-tools','package.json'));
 let convert:(input:{buffer:Buffer;format:'JPEG';quality:number})=>Promise<ArrayBuffer>;
 try{convert=requireConverter('heic-convert');}catch{throw Error('Existing HEIC decoder unavailable; original preserved, no provider request permitted');}
 const derivative=Buffer.from(await convert({buffer:original,format:'JPEG',quality:1}));
 if(derivative.length>35_000_000||derivative[0]!==255||derivative[1]!==216)throw Error('Invalid bounded HEIC derivative');
 const decoded=await sharp(derivative,{limitInputPixels:80_000_000}).metadata();
 if(!decoded.width||!decoded.height||decoded.width*decoded.height>80_000_000)throw Error('Invalid decoded HEIC dimensions');
 return derivative;
}

/** Small process-local promise cache deduplicates simultaneous worker/media/
 * preview decodes. Eight bounded entries; never a replacement original file. */
export async function v2DecodableImage(bytes:Uint8Array,root=process.cwd()):Promise<Buffer>{
 const original=Buffer.from(bytes);if(original.length>35_000_000)throw Error('Bounded original image required');
 if(!isV2Heic(original))return original;
 const key=path.resolve(root)+':heic-convert-2.1.0:'+createHash('sha256').update(original).digest('hex');
 const existing=cache.get(key);if(existing)return existing;
 while(cache.size>=8)cache.delete(cache.keys().next().value!);
 const result=decodeHeic(original,root);cache.set(key,result);
 try{return await result;}catch(error){if(cache.get(key)===result)cache.delete(key);throw error;}
}
