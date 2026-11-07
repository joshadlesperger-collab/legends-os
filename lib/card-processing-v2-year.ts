/** Only the explicit non-sports absent-year sentinel is omitted from listing facts. */
export function v2FactualYear(identity:{categoryId:string;year:string}){
 return identity.categoryId!=="261328"&&identity.year.trim()==="Not specified"?"":identity.year;
}
