export type SellerOpportunityView="singles"|"lots"|"all";

type ClassifiedOpportunity={kind:"single"|"lot"};
type SearchableOpportunity=ClassifiedOpportunity&{searchText:string};

export function opportunitiesForView<T extends ClassifiedOpportunity>(rows:readonly T[],view:SellerOpportunityView):T[]{
  if(view==="singles")return rows.filter(row=>row.kind==="single");
  if(view==="lots")return rows.filter(row=>row.kind==="lot");
  return [...rows];
}

export function searchOpportunitiesForView<T extends SearchableOpportunity>(rows:readonly T[],view:SellerOpportunityView,query:string):T[]{
  const currentView=opportunitiesForView(rows,view);
  const normalized=query.trim().toLocaleLowerCase();
  return normalized?currentView.filter(row=>row.searchText.includes(normalized)):currentView;
}
