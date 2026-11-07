import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {getItem,type EbayListingItem} from './ebay.ts';
import {v2DraftPoliciesSchema} from './card-processing-v2-draft-lifecycle.ts';

function profile(rawId:unknown,rawName:unknown){
 const id=typeof rawId==='string'&&/^\d+$/.test(rawId)?rawId:typeof rawId==='number'&&Number.isSafeInteger(rawId)&&rawId>0?String(rawId):null;
 if(!id||typeof rawName!=='string'||!rawName.trim())throw Error('Fresh seller policy ID and name are required');
 const name=rawName.trim(),suffix=/\s+\((\d+)\)$/.exec(name);if(suffix&&suffix[1]!==id)throw Error('Actual seller profile name and ID contradict each other');
 return{id,label:suffix?name.slice(0,suffix.index).trim():name,observedName:name};
}
/** ID suffixes are normalized only when they exactly bind to the independently
 * returned profile ID. Preserve the raw labels as provenance; never invent an
 * ID/ZIP, accept returns or infer an option from an expected UI value. */
export function projectV2BackgroundPolicies(item:EbayListingItem,itemId:string){
 if(!/^\d+$/.test(itemId)||String(item.ItemID)!==itemId)throw Error('An exact freshly observed active item is required');
 const seller=item.Seller as {UserID?:string}|undefined;if(seller?.UserID?.toLowerCase()!=='imaydit58')throw Error('Policy source is not the bound seller');
 const profiles=item.SellerProfiles as {SellerPaymentProfile?:{PaymentProfileID?:unknown;PaymentProfileName?:unknown};SellerReturnProfile?:{ReturnProfileID?:unknown;ReturnProfileName?:unknown}}|undefined;
 const payment=profile(profiles?.SellerPaymentProfile?.PaymentProfileID,profiles?.SellerPaymentProfile?.PaymentProfileName),returns=profile(profiles?.SellerReturnProfile?.ReturnProfileID,profiles?.SellerReturnProfile?.ReturnProfileName),returnPolicy=item.ReturnPolicy as {ReturnsAcceptedOption?:string}|undefined;
 const postal=typeof item.PostalCode==='string'?item.PostalCode.trim():typeof item.PostalCode==='number'&&Number.isSafeInteger(item.PostalCode)&&/^\d{5}$/.test(String(item.PostalCode))?String(item.PostalCode):null;
 if(returnPolicy?.ReturnsAcceptedOption!=='ReturnsNotAccepted'||returns.label!=='No Return Accepted'||item.Country!=='US'||typeof item.Location!=='string'||!item.Location.trim()||!postal||!/^\d{5}(?:-\d{4})?$/.test(postal))throw Error('Fresh seller no-returns policy and unmasked established US postal location are required');
 const location=item.Location.trim(),policies=v2DraftPoliciesSchema.parse({payment:payment.label,returns:'No Return Accepted',shipping:null,location,pricingShippingUnresolved:true});
 const defaults={payment:{id:payment.id,label:payment.label},returns:{id:returns.id,label:'No Return Accepted' as const},location:{postalCode:postal,city:location.split(',')[0].trim(),country:'US' as const}};
 const csvDefaults={location,paymentProfileName:payment.observedName,returnProfileName:returns.observedName,returnsAcceptedOption:'ReturnsNotAccepted' as const};
 return{policies,defaults,csvDefaults,observedProfiles:{payment:{id:payment.id,name:payment.observedName},returns:{id:returns.id,name:returns.observedName}},returnsAcceptedOption:returnPolicy.ReturnsAcceptedOption};
}
/** Seller-owned read only: copy policy identity/location, never price/shipping.
 * The optional adapter is for isolated transport fixtures, never supplied by UI. */
export async function readV2BackgroundPolicies(root:string,itemId:string,accessToken:string,deps:{getItem?:typeof getItem}={}){
 if(!/^\d+$/.test(itemId))throw Error('A freshly observed seller-owned active item is required for account defaults');
 const item=await(deps.getItem??getItem)(accessToken,itemId),projected=projectV2BackgroundPolicies(item,itemId);
 const body={kind:'actual-seller-owned-background-policy-read',seller:'imaydit58',observedAt:new Date().toISOString(),itemId,...projected,source:'GetItem ReturnAll; seller-owned active inventory source; price and shipping excluded; optional ID suffixes validated against separately returned profile IDs'};
 const relative=`artifacts/card-processing-v2/background/evidence/policies-${randomUUID()}.json`,bytes=JSON.stringify(body);await fs.mkdir(path.dirname(path.join(root,relative)),{recursive:true});await fs.writeFile(path.join(root,relative),bytes,{flag:'wx',flush:true});
 const evidence={path:relative,sha256:createHash('sha256').update(bytes).digest('hex')};return{policies:projected.policies,defaults:{...projected.defaults,evidence},csvDefaults:{...projected.csvDefaults,evidence},evidence};
}
