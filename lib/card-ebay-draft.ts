import { projectListing, type DraftCard } from "./card-listing-factory.ts";
import { projectPricing } from "./card-pricing-review.ts";

// User-selected destination, not proof of a connected or authorized seller grant.
export const FACTORY_SELLER_USERNAME = "imaydit58";

/** Local handoff only. No credentials, network calls, executable API payload or publish action. */
export function prepareEbayDraftReview(draft: DraftCard, today?: string) {
  const listing = projectListing(draft);
  const pricing = projectPricing(draft, today);
  const localReasons = [...listing.reviewReasons, ...pricing.reviewReasons];
  if (!pricing.approved && !pricing.reviewReasons.length) localReasons.push("Approve the current price and shipping first.");
  const localReviewReady = localReasons.length === 0;
  return {
    schema: "legends-ebay-draft-handoff-v1",
    destination: "local-handoff-only",
    intendedSeller: FACTORY_SELLER_USERNAME,
    marketplace: "EBAY_US",
    localReviewReady,
    canCreateEbayOffer: false,
    canPublish: false,
    localReasons: Array.from(new Set(localReasons)),
    connectionRequirements: [
      "Verify the connected seller is imaydit58 and prove the credential environment and inventory write grant.",
      "Validate the category, category-specific condition and required item specifics; raw does not imply a condition grade.",
      "Host the original front and back photos with approved access; preserve front as the first image. Browser blob previews cannot be sent to eBay as image URLs.",
      "Select the seller's inventory location and payment, return and fulfillment policies; verify the fulfillment policy charges the approved shipping amount.",
      "Implement durable idempotency and audit records, sandbox validation and the separate action-specific create-draft write gate before any eBay mutation.",
    ],
    // Partial review data, intentionally withheld until all LOCAL approvals remain valid.
    preparedReview: localReviewReady ? {
      title: listing.title,
      description: listing.description,
      specifics: listing.specifics,
      quantity: listing.quantity,
      price: { value: pricing.listingPrice!.toFixed(2), currency: "USD" },
      buyerShippingCharge: { value: pricing.shippingCharge!.toFixed(2), currency: "USD" },
      promotion: { strategy: "GENERAL", ratePercent: pricing.generalPromotionPercent, enabled: pricing.generalPromotionPercent > 0, estimatedFeeBeforeTax: pricing.estimatedPromotionFeeBeforeTax, requiresEbayVerification: true },
      sourceImageIds: [draft.frontImageId!, draft.backImageId!],
      financialApprovalSnapshot: pricing.snapshot,
    } : null,
  };
}
