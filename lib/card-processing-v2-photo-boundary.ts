import path from 'node:path';
import type {V2Card} from './card-processing-v2.ts';
const equivalent=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
/** Same route boundary for original, Drafted, Listed and Sold. Resolver hashing remains separately required. */
export function assertV2PreviewBoundary(folder:string,filename:string,card:V2Card,photo:V2Card['photos'][number]){
 folder=path.resolve(folder);filename=path.resolve(filename);
 if(!card.photos.some(p=>p.path===photo.path&&p.hash===photo.hash&&p.side===photo.side))throw Error('Foreign preview capture');
 let expected=folder;const inventory=card.inventoryArchive;
 if(inventory&&inventory.captureId===card.captureId&&inventory.sku===card.sku&&inventory.draftId===card.draftId&&inventory.files.some(f=>f.original===path.resolve(photo.path)&&f.hash===photo.hash&&f.side===photo.side&&equivalent(path.resolve(f.destination),filename))){expected=path.join(folder,inventory.disposition==='sold'?'Sold':'Listed',inventory.itemId);}
 else if(card.draftArchive?.status==='moved'&&card.draftArchive.captureId===card.captureId&&card.draftArchive.draftId===card.draftId&&card.draftArchive.files.some(f=>f.source===path.resolve(photo.path)&&f.hash===photo.hash&&f.side===photo.side&&equivalent(path.resolve(f.destination),filename))){expected=path.join(folder,'Drafted',card.draftId!);}
 if(!equivalent(path.dirname(filename),expected))throw Error('Outside exact configured photo folder');
 return expected;
}
