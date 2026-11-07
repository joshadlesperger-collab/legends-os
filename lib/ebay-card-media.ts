/** eBay Media API v1_beta.5.1. Uploads images only; no listing methods. */
export async function uploadCardImage(token:string,bytes:Uint8Array,mime:string,fetcher:typeof fetch=fetch){
  const form=new FormData();form.set("image",new Blob([new Uint8Array(bytes)],{type:mime}),"card-photo");
  const response=await fetcher("https://apim.ebay.com/commerce/media/v1_beta/image/create_image_from_file",{method:"POST",headers:{Authorization:`Bearer ${token}`},body:form,signal:AbortSignal.timeout(30000),redirect:"error"});
  if(response.status!==201)throw Error(`eBay photo upload returned HTTP ${response.status}; no listing was created.`);
  const location=response.headers.get("location"),data=await response.json() as {imageUrl?:string;expirationDate?:string};
  if(!location||!/^https:\/\/apim\.ebay\.com\/commerce\/media\/v1_beta\/image\/[^/?#]+$/.test(location))throw Error("eBay photo upload did not return its image resource URI.");
  let url:URL;try{url=new URL(data.imageUrl??"");}catch{throw Error("eBay image URL missing.");}
  if(url.protocol!=="https:"||!/(^|\.)ebayimg\.com$/i.test(url.hostname)||url.username||url.password||!Number.isFinite(Date.parse(data.expirationDate??"")))throw Error("eBay image URL or expiration invalid.");
  return {url:url.href,expiresAt:data.expirationDate!,resourceUri:location};
}
