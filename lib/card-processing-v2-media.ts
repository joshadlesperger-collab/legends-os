import {AsyncLocalStorage} from 'node:async_hooks';
import {v2OrientedImage,readV2PhotoRotations} from './card-processing-v2-photo-rotation.ts';
import sharp from "sharp";
import { uploadCardImage } from "./ebay-card-media.ts";
import { v2SellerAccess } from "./card-processing-v2-connection.ts";
import {observeV2PhotoStep,type V2PhotoTimingObserver} from './card-processing-v2-photo-timing.ts';

type PhotoResources={root:string;rotations:Awaited<ReturnType<typeof readV2PhotoRotations>>};
const photoResources=new AsyncLocalStorage<PhotoResources>();
export function withV2PhotoResources<T>(resources:PhotoResources,action:()=>T):T{return photoResources.run(resources,action);}

/** Lazy, seller-bound connection using the existing OAuth flow. No inventory or listing writes. */
export function v2PhotoHost(connection = v2SellerAccess()) {
  return async (bytes: Uint8Array, _hash: string, observer?:V2PhotoTimingObserver) => {
    // One failed connection is shared across this bounded run, never retried for each card.
    const accessToken = await observeV2PhotoStep(observer,'photo-connection-read',connection);
    const upright = await observeV2PhotoStep(observer,'photo-orientation-encode',async()=>sharp(await v2OrientedImage(bytes,photoResources.getStore()?.root,photoResources.getStore()?.rotations), { limitInputPixels: 80_000_000 }).rotate().jpeg({ quality: 95 }).toBuffer());
    const result = await observeV2PhotoStep(observer,'photo-eps-request',()=>uploadCardImage(accessToken, upright, "image/jpeg"));
    return { url: result.url, expiresAt: result.expiresAt };
  };
}
