/** Player demand metrics are observations, not automatic price multipliers. */
export type PlayerSale = {id:string;playerId:string;productId:string;soldAt:string;landedPrice:number;verified:boolean};
export type PlayerListing = {id:string;playerId:string;observedAt:string;active:boolean};
export type PlayerDemand = {playerId:string;asOf:string;sold7:number;sold30:number;sold90:number;gross30:number;growth30vsPrevious30:number|null;activeListings:number|null;sellThroughProxy30:number|null;confidence:"insufficient"|"limited"|"observed"};
export function playerDemand(playerId:string,sales:PlayerSale[],listings:PlayerListing[]|null,asOf=new Date()):PlayerDemand {
 const now=asOf.getTime(),day=86400000;
 const eligible=sales.filter(s=>s.playerId===playerId&&s.verified&&Number.isFinite(s.landedPrice)&&s.landedPrice>0&&Number.isFinite(Date.parse(s.soldAt))&&Date.parse(s.soldAt)<=now);
 const count=(from:number,to:number)=>eligible.filter(s=>{const age=(now-Date.parse(s.soldAt))/day;return age>=from&&age<to});
 const d7=count(0,7),d30=count(0,30),d90=count(0,90),previous=count(30,60);
 const active=listings===null?null:listings.filter(l=>l.playerId===playerId&&l.active&&Date.parse(l.observedAt)<=now).length;
 return {playerId,asOf:asOf.toISOString(),sold7:d7.length,sold30:d30.length,sold90:d90.length,
 gross30:Math.round(d30.reduce((sum,s)=>sum+s.landedPrice,0)*100)/100,
 growth30vsPrevious30:previous.length?Math.round((d30.length/previous.length-1)*10000)/100:null,
 activeListings:active,sellThroughProxy30:active===null||active+d30.length===0?null:Math.round(d30.length/(active+d30.length)*10000)/100,
 confidence:d90.length>=30?"observed":d90.length>=5?"limited":"insufficient"};
}
