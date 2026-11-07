/** Deterministic draft text. Unknown facts stay missing instead of being generated. */
export function draftFields(identity:Record<string,unknown>) {
  const value=(key:string)=>identity[key]==null?"":String(identity[key]).trim();
  const sport=value("sport"),tcg=/pokemon|pokémon|magic|one piece|yu.gi.oh|lorcana/i.test(sport);
  const category=tcg?"CCG Individual Cards":/basketball|baseball|football|soccer|hockey|wrestling|racing|golf|tennis/i.test(sport)?"Sports Trading Card Singles":null;
  const brand=/magic/i.test(sport)?"MTG":/pok[eé]mon/i.test(sport)?"Pokemon":sport;
  const compactSet=value("set").replace(/UEFA Women's Champions League/gi,"UWCL").replace(/UEFA Women’s Champions League/gi,"UWCL");
  const parts=tcg?[brand,value("player"),`#${value("cardNumber")}`,value("parallel"),value("language")]:[value("season"),compactSet,value("player"),`#${value("cardNumber")}`,value("parallel"),value("serial")];
  const title=parts.filter(Boolean).join(" ").replace(/\s+/g," ").trim();
  const fields:Record<string,string>=tcg
    ? {Game:sport,"Card Name":value("player"),Set:value("set"),"Card Number":value("cardNumber"),Language:value("language"),Manufacturer:value("manufacturer"),"Year Manufactured":value("season"),Finish:/non[ -]?(foil|holo)/i.test(value("parallel"))?"Regular":/reverse[ -]?holo/i.test(value("parallel"))?"Reverse Holo":/holo/i.test(value("parallel"))?"Holo":/foil/i.test(value("parallel"))?"Foil":""}
    : {Sport:sport,"Player/Athlete":value("player"),Set:value("set"),Season:value("season"),Manufacturer:value("manufacturer"),"Card Number":value("cardNumber"),Team:value("team"),"Parallel/Variety":value("parallel"),"Serial Number":value("serial")};
  const missing=[...(!category?["Category requires review"]:[]),...(!value("player")||!value("set")||!value("cardNumber")||!value("parallel")?["Complete card identity required"]:[]),...(!value("condition")?["Condition required"]:[]),...(tcg&&!value("language")?["TCG language must be explicitly reviewed"]:[]),...(title.length>80?["Reviewed title must fit 80 characters"]:[])];
  return {title,category,condition:value("condition"),specifics:Object.fromEntries(Object.entries(fields).filter(([,v])=>v)),
    description:`${title}. Condition: ${value("condition")||"requires review"}. One card per purchase. Please inspect the front and back photos.`,missing};
}
