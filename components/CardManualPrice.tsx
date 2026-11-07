"use client";
import { useState } from "react";
import type { BacklogCard, BacklogPrice } from "@/lib/card-backlog";
import { suggestedManualShipping, validManualPrice, type ManualPrice } from "@/lib/card-workflow";
import styles from "./CardWorkflow.module.css";

const amount=(value:string)=>/^\d+(?:\.\d{1,2})?$|^\.\d{1,2}$/.test(value.trim())?Number(value):NaN;
export default function CardManualPrice({card,asking,busy,inPricing,onSave}:{card:BacklogCard;asking?:BacklogPrice|null;busy:boolean;inPricing:boolean;onSave:(price:ManualPrice)=>Promise<void>}) {
  const [item,setItem]=useState("");
  const [shipping,setShipping]=useState(asking?.shipping==null?"":asking.shipping.toFixed(2));
  const [shippingEdited,setShippingEdited]=useState(asking?.policy==="seller-manual-price-v1");
  const price={item:amount(item),shipping:amount(shipping)},valid=validManualPrice(price);
  function changeItem(value:string) {
    setItem(value);
    const parsed=amount(value);
    if(!shippingEdited&&Number.isFinite(parsed)&&parsed>0)setShipping(suggestedManualShipping(card,parsed).toFixed(2));
  }
  return <form className={styles.manualPrice} aria-label="Manual asking price" onSubmit={e=>{e.preventDefault();if(valid&&!busy)void onSave(price);}}>
    <h4>Set a manual price</h4>
    <div className={styles.manualPriceFields}>
      <label>Item price (USD)<input name="manual-item-price" inputMode="decimal" autoComplete="off" disabled={busy} value={item} onChange={e=>changeItem(e.target.value)} placeholder={asking?asking.item.toFixed(2):"0.00"} aria-describedby="manual-price-help"/></label>
      <label>Buyer shipping (USD)<input name="manual-shipping" inputMode="decimal" autoComplete="off" disabled={busy} value={shipping} onChange={e=>{setShipping(e.target.value);setShippingEdited(true);}} placeholder="0.00"/></label>
    </div>
    <p id="manual-price-help">Your exact price overrides automated estimates. Shipping follows the saved defaults unless you edit it.</p>
    <button className={styles.primary} type="submit" disabled={busy||!valid}>{busy?"Saving…":inPricing?"Save price & move to listing review →":"Save manual price"}</button>
  </form>;
}
