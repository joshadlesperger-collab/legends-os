import {createHash} from 'node:crypto';
import type {V2Card} from './card-processing-v2.ts';
const norm=(s:string)=>s.normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
/** Stable catalog identity for newly admitted quantity groups. Free-form pose
 * prose is not a discriminator. Old frozen IDs must retain their original key.
 * Numbered physical copies always retain distinct capture ownership.
 */
export function v2StableCatalogIdentityKey(c:Pick<V2Card,'identity'|'condition'|'captureId'>){
 if(!c.identity)throw Error('Identified catalog identity required');
 const i=c.identity,distinguishing=new Set(['finish','edition','image variation','variation','autographed','autograph authentication','card thickness','material','card size']);
 const specifics=Object.entries(i.specifics).filter(([k])=>distinguishing.has(norm(k))).map(([k,values])=>[norm(k),values.map(norm).sort()] as const).sort(([a],[b])=>a.localeCompare(b));
 const namedArtwork=/\b(?:alternate|alternative|variation|short[ -]print|manga|image [a-z])\b/i.test(i.artwork)?norm(i.artwork):'';
 const fields=[[i.name,i.year,i.manufacturer,i.product,i.number,i.categoryId,i.language,i.variant,i.sportOrGame,c.condition].map(norm),i.graded,i.damage,namedArtwork,specifics,i.serial?c.captureId:'unnumbered'];
 return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
