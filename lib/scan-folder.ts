export type ScanFile = { path: string; hash: string };
export type ScanSummary = { imageFiles: number; uniqueImages: number; duplicateFiles: number; pairedCards: number; unmatchedImages: number; mode: string };
export function summarizeScanFolder(files: ScanFile[], mode: "named" | "alternating" | "fronts-only"): ScanSummary {
  const hashes = new Set<string>();
  const unique = files.filter(f=>{if(hashes.has(f.hash))return false;hashes.add(f.hash);return true;});
  let pairedCards=0, unmatchedImages=0;
  if(mode === "fronts-only") pairedCards=unique.length;
  else if(mode === "alternating") {pairedCards=Math.floor(unique.length/2);unmatchedImages=unique.length%2;}
  else {
    const groups = new Map<string,{front:number;back:number}>();
    for(const f of unique){
      const stem=f.path.replace(/\.[^.]+$/,"");
      const match=stem.match(/^(.*?)[ _.-](front|back|f|b)$/i);
      if(!match){unmatchedImages++;continue;}
      const key=match[1].toLowerCase();const group=groups.get(key)??{front:0,back:0};
      group[/^(front|f)$/i.test(match[2]) ? "front" : "back"]++;groups.set(key,group);
    }
    groups.forEach(g=>{if(g.front===1&&g.back===1)pairedCards++;else unmatchedImages+=g.front+g.back;});
  }
  return {imageFiles:files.length,uniqueImages:unique.length,duplicateFiles:files.length-unique.length,pairedCards,unmatchedImages,mode};
}
