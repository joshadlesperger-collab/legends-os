import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { allocateSellerProceeds, calculateKnownCapital, calculateKnownCostEconomics, type CostComponents } from "@/lib/profitability";

const DAY_MS = 24 * 60 * 60 * 1000;
const money = (value: Prisma.Decimal | null | undefined) => Number(value ?? 0);

export type BestSeller = {
  key: string;
  title: string;
  units: number;
  gross: number;
  saleCount: number;
  units30: number;
  latestSale: Date;
  linked: boolean;
  listingId: string | null;
  costBasis: { unitAcquisitionCost: number | null; unitGradingCost: number | null; unitSuppliesCost: number | null; unitOutboundPostageCost: number | null; unitOtherCost: number | null; notes: string | null } | null;
  knownUnitCost: number | null;
  knownCostMargin: number | null;
};

type BestSellerRow = {
  key: string;
  title: string;
  units: bigint;
  gross: Prisma.Decimal;
  sale_count: bigint;
  units_30: bigint;
  latest_sale: Date;
  linked: boolean;
};

export async function loadCommerceDashboard(now = new Date()) {
  const since7 = new Date(now.getTime() - 7 * DAY_MS);
  const since30 = new Date(now.getTime() - 30 * DAY_MS);
  const since90 = new Date(now.getTime() - 90 * DAY_MS);
  const activeOrderWhere: Prisma.EbayOrderWhereInput = { cancelStatus: { not: "CANCELED" } };

  const [
    orderCount, orderMoney, refundMoney, lineTotals, sales7, sales30, units30, sales90,
    linkedLines, unlinkedLines, listingCount, listingsWithSalesRows,
    orderStates, saleStates, recentSales, highestSales, exceptionSales, bestSellerRows,
    latestOrderJob, latestCompletedOrderJob, earliestOrder, latestOrder, economicLines, activeCostListings,
  ] = await Promise.all([
    prisma.ebayOrder.count(),
    prisma.ebayOrder.aggregate({ where: activeOrderWhere, _sum: { total: true, totalDueSeller: true, totalMarketplaceFee: true, deliveryCost: true }, _count: { totalDueSeller: true, totalMarketplaceFee: true, deliveryCost: true } }),
    prisma.ebayRefund.aggregate({ _sum: { amount: true }, _count: { _all: true, amount: true } }),
    prisma.ebayOrderLine.aggregate({ where: { order: activeOrderWhere }, _sum: { quantity: true, lineItemCost: true }, _count: { _all: true } }),
    prisma.ebayOrder.aggregate({ where: { ...activeOrderWhere, creationDate: { gte: since7 } }, _sum: { total: true } }),
    prisma.ebayOrder.aggregate({ where: { ...activeOrderWhere, creationDate: { gte: since30 } }, _sum: { total: true }, _count: { _all: true } }),
    prisma.ebayOrderLine.aggregate({ where: { order: { ...activeOrderWhere, creationDate: { gte: since30 } } }, _sum: { quantity: true } }),
    prisma.ebayOrder.aggregate({ where: { ...activeOrderWhere, creationDate: { gte: since90 } }, _sum: { total: true } }),
    prisma.ebayOrderLine.count({ where: { listingId: { not: null } } }),
    prisma.ebayOrderLine.count({ where: { listingId: null } }),
    prisma.listing.count(),
    prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT COUNT(DISTINCT ol."listingId") AS count FROM "EbayOrderLine" ol JOIN "SaleEvent" se ON se."orderLineId" = ol.id WHERE ol."listingId" IS NOT NULL AND se.status <> 'cancelled'`),
    prisma.ebayOrder.groupBy({ by: ["orderPaymentStatus", "orderFulfillmentStatus", "cancelStatus"], _count: { _all: true }, orderBy: [{ orderPaymentStatus: "asc" }, { orderFulfillmentStatus: "asc" }, { cancelStatus: "asc" }] }),
    prisma.saleEvent.groupBy({ by: ["status"], where: { provider: "ebay-fulfillment" }, _count: { _all: true }, orderBy: { status: "asc" } }),
    prisma.ebayOrderLine.findMany({ take: 40, orderBy: { order: { creationDate: "desc" } }, select: {
      id: true, title: true, quantity: true, lineItemCost: true, total: true, currency: true, listingId: true,
      order: { select: { creationDate: true, providerOrderId: true, totalDueSeller: true, totalMarketplaceFee: true, cancelStatus: true, orderPaymentStatus: true } },
      listing: { select: { title: true } }, saleEvent: { select: { status: true, price: true } },
    }}),
    prisma.ebayOrderLine.findMany({ take: 10, orderBy: { lineItemCost: "desc" }, select: { id: true, title: true, quantity: true, lineItemCost: true, currency: true, listingId: true, order: { select: { creationDate: true } }, saleEvent: { select: { status: true } } } }),
    prisma.ebayOrderLine.findMany({ where: { saleEvent: { status: { in: ["cancelled", "refunded", "partially_refunded"] } } }, take: 25, orderBy: { order: { creationDate: "desc" } }, select: { id: true, title: true, quantity: true, lineItemCost: true, currency: true, listingId: true, order: { select: { creationDate: true, orderPaymentStatus: true, cancelStatus: true } }, saleEvent: { select: { status: true } }, refunds: { select: { amount: true, currency: true, status: true } } } }),
    prisma.$queryRaw<BestSellerRow[]>(Prisma.sql`
      SELECT COALESCE(l.id, ol."ebayItemId", ol."providerLineItemId") AS key,
        COALESCE(MAX(l.title), MAX(ol.title)) AS title,
        SUM(ol.quantity)::bigint AS units,
        SUM(ol."lineItemCost") AS gross,
        COUNT(*)::bigint AS sale_count,
        COALESCE(SUM(ol.quantity) FILTER (WHERE o."creationDate" >= ${since30}), 0)::bigint AS units_30,
        MAX(o."creationDate") AS latest_sale,
        BOOL_OR(ol."listingId" IS NOT NULL) AS linked
      FROM "EbayOrderLine" ol
      JOIN "EbayOrder" o ON o.id = ol."orderId"
      LEFT JOIN "Listing" l ON l.id = ol."listingId"
      WHERE o."cancelStatus" <> 'CANCELED'
      GROUP BY COALESCE(l.id, ol."ebayItemId", ol."providerLineItemId")
      ORDER BY SUM(ol."lineItemCost") DESC
      LIMIT 15
    `),
    prisma.syncJob.findFirst({ where: { type: "orders_incremental" }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, attemptCount: true, failureCount: true, progress: true, orderTotal: true, orderNextOffset: true, heartbeatAt: true, completedAt: true, errorMessage: true, store: { select: { orderSyncCheckpoint: true } } } }),
    prisma.syncJob.findFirst({ where: { type: "orders_incremental", status: "completed" }, orderBy: { completedAt: "desc" }, select: { completedAt: true } }),
    prisma.ebayOrder.findFirst({ orderBy: { creationDate: "asc" }, select: { creationDate: true } }),
    prisma.ebayOrder.findFirst({ orderBy: { creationDate: "desc" }, select: { creationDate: true } }),
    prisma.ebayOrderLine.findMany({ where: { listingId: { not: null }, order: activeOrderWhere }, select: { id: true, title: true, quantity: true, lineItemCost: true, listingId: true, refunds: { select: { amount: true } }, order: { select: { total: true, totalDueSeller: true, cancelStatus: true, creationDate: true } }, listing: { select: { title: true, startTime: true, costBasis: true } } } }),
    prisma.listing.findMany({ where: { listingStatus: "active", costBasis: { isNot: null } }, select: { id: true, title: true, quantity: true, currentPrice: true, startTime: true, watchers: true, views: true, costBasis: true, saleEvents: { where: { provider: "ebay-fulfillment", status: { not: "cancelled" } }, select: { quantity: true, soldAt: true } } } }),
  ]);

  const units = lineTotals._sum.quantity ?? 0;
  const lineCount = linkedLines + unlinkedLines;
  const refundedOrders = orderStates.filter((row) => row.orderPaymentStatus === "FULLY_REFUNDED").reduce((sum, row) => sum + row._count._all, 0);
  const partiallyRefundedOrders = orderStates.filter((row) => row.orderPaymentStatus === "PARTIALLY_REFUNDED").reduce((sum, row) => sum + row._count._all, 0);
  const cancelledOrders = orderStates.filter((row) => row.cancelStatus === "CANCELED").reduce((sum, row) => sum + row._count._all, 0);
  const listingsWithSales = Number(listingsWithSalesRows[0]?.count ?? 0);
  const linkedBestSellerIds = bestSellerRows.filter((row) => row.linked).map((row) => row.key);
  const costBasisRows = linkedBestSellerIds.length ? await prisma.listingCostBasis.findMany({ where: { listingId: { in: linkedBestSellerIds } }, select: {
    listingId: true, unitAcquisitionCost: true, unitGradingCost: true, unitSuppliesCost: true, unitOutboundPostageCost: true, unitOtherCost: true, notes: true,
  }}) : [];
  const costBasisByListing = new Map(costBasisRows.map((row) => [row.listingId, row]));
  const toComponents = (row: { unitAcquisitionCost: Prisma.Decimal | null; unitGradingCost: Prisma.Decimal | null; unitSuppliesCost: Prisma.Decimal | null; unitOutboundPostageCost: Prisma.Decimal | null; unitOtherCost: Prisma.Decimal | null }): CostComponents => ({ acquisition: row.unitAcquisitionCost == null ? null : Number(row.unitAcquisitionCost), grading: row.unitGradingCost == null ? null : Number(row.unitGradingCost), supplies: row.unitSuppliesCost == null ? null : Number(row.unitSuppliesCost), postage: row.unitOutboundPostageCost == null ? null : Number(row.unitOutboundPostageCost), other: row.unitOtherCost == null ? null : Number(row.unitOtherCost) });
  const lineEconomics = economicLines.flatMap((line) => { if (!line.listing?.costBasis) return []; const lineGross=Number(line.lineItemCost); const allocated=allocateSellerProceeds({orderSellerProceeds:line.order.totalDueSeller==null?null:Number(line.order.totalDueSeller),orderGross:Number(line.order.total),lineGross}); const economics=calculateKnownCostEconomics({quantity:line.quantity,lineGross,allocatedSellerProceeds:allocated,refundAmount:line.refunds.reduce((sum,row)=>sum+Number(row.amount??0),0),cancelled:line.order.cancelStatus==="CANCELED",costs:toComponents(line.listing.costBasis)}); return economics.knownCostMargin==null?[]:[{id:line.id,title:line.listing.title,listingId:line.listingId!,soldAt:line.order.creationDate,lineGross,...economics}]; });
  const coveredGross=lineEconomics.reduce((sum,row)=>sum+row.lineGross,0); const coveredUnits=economicLines.filter(line=>line.listing?.costBasis!=null).reduce((sum,line)=>sum+line.quantity,0); const marginBasis=lineEconomics.reduce((sum,row)=>sum+(row.netBasis??0),0); const knownMargin=lineEconomics.reduce((sum,row)=>sum+(row.knownCostMargin??0),0); const invested=lineEconomics.reduce((sum,row)=>sum+(row.investedCost??0),0);
  const capitalRows=activeCostListings.map(row=>{const capital=calculateKnownCapital({quantity:row.quantity,costs:toComponents(row.costBasis!),listedAt:row.startTime,now});return{id:row.id,title:row.title,currentPrice:Number(row.currentPrice),quantity:row.quantity,watchers:row.watchers,views:row.views,soldUnits:row.saleEvents.reduce((sum,sale)=>sum+sale.quantity,0),latestSale:row.saleEvents.map(sale=>sale.soldAt).sort((a,b)=>b.getTime()-a.getTime())[0]??null,...capital};}).filter(row=>row.knownCapital!=null);
  const capitalByAge=Object.fromEntries(["0-30","31-60","61-90","91-180","180+","unknown"].map(band=>[band,capitalRows.filter(row=>row.ageBand===band).reduce((sum,row)=>sum+(row.knownCapital??0),0)]));

  return {
    generatedAt: now,
    summary: {
      grossSales: money(orderMoney._sum.total),
      providerProceeds: money(orderMoney._sum.totalDueSeller),
      providerProceedsOrders: orderMoney._count.totalDueSeller,
      marketplaceFees: money(orderMoney._sum.totalMarketplaceFee),
      marketplaceFeeOrders: orderMoney._count.totalMarketplaceFee,
      providerDelivery: money(orderMoney._sum.deliveryCost),
      providerDeliveryOrders: orderMoney._count.deliveryCost,
      refunds: money(refundMoney._sum.amount),
      refundCount: refundMoney._count._all,
      refundAmountCount: refundMoney._count.amount,
      orders: orderCount,
      units,
      averageSellingPrice: units > 0 ? money(lineTotals._sum.lineItemCost) / units : 0,
      sales7: money(sales7._sum.total), sales30: money(sales30._sum.total), orders30: sales30._count._all, units30: units30._sum.quantity ?? 0, sales90: money(sales90._sum.total),
      refundRate: orderCount > 0 ? ((refundedOrders + partiallyRefundedOrders) / orderCount) * 100 : 0,
      cancelledOrders, refundedOrders, partiallyRefundedOrders,
      knownCostMargin: lineEconomics.length ? knownMargin : null,
      knownCostMarginPct: marginBasis>0 ? knownMargin*100/marginBasis : null,
      knownMarginSales: lineEconomics.length,
      aggregateRoi: invested>0 ? knownMargin*100/invested : null,
    },
    coverage: {
      lineCount, linkedLines, unlinkedLines,
      linkedPercent: lineCount > 0 ? (linkedLines / lineCount) * 100 : 0,
      listingCount, listingsWithSales, listingsWithoutSales: Math.max(0, listingCount - listingsWithSales),
      salesGrossWithCost: coveredGross,
      salesDollarCostCoveragePct: Number(lineTotals._sum.lineItemCost??0)>0 ? coveredGross*100/Number(lineTotals._sum.lineItemCost) : 0,
      unitsWithCost: coveredUnits,
      unitCostCoveragePct: units>0 ? coveredUnits*100/units : 0,
    },
    range: { earliest: earliestOrder?.creationDate ?? null, latest: latestOrder?.creationDate ?? null },
    orderStates, saleStates, recentSales, highestSales, exceptionSales,
    bestSellers: bestSellerRows.map((row): BestSeller => {
      const source = row.linked ? costBasisByListing.get(row.key) ?? null : null;
      const costBasis = source ? { unitAcquisitionCost: source.unitAcquisitionCost == null ? null : Number(source.unitAcquisitionCost), unitGradingCost: source.unitGradingCost == null ? null : Number(source.unitGradingCost), unitSuppliesCost: source.unitSuppliesCost == null ? null : Number(source.unitSuppliesCost), unitOutboundPostageCost: source.unitOutboundPostageCost == null ? null : Number(source.unitOutboundPostageCost), unitOtherCost: source.unitOtherCost == null ? null : Number(source.unitOtherCost), notes: source.notes } : null;
      const hasKnownCost = costBasis != null && Object.entries(costBasis).some(([key, value]) => key !== "notes" && value != null);
      const knownUnitCost = hasKnownCost ? Object.entries(costBasis!).reduce((sum, [key, value]) => key === "notes" || value == null ? sum : sum + Number(value), 0) : null;
      return { key: row.key, title: row.title, units: Number(row.units), gross: money(row.gross), saleCount: Number(row.sale_count), units30: Number(row.units_30), latestSale: row.latest_sale, linked: row.linked, listingId: row.linked ? row.key : null, costBasis, knownUnitCost, knownCostMargin: knownUnitCost == null ? null : money(row.gross) - knownUnitCost * Number(row.units) };
    }),
    profitability: { winners:[...lineEconomics].sort((a,b)=>(b.knownCostMargin??0)-(a.knownCostMargin??0)).slice(0,10), losers:[...lineEconomics].sort((a,b)=>(a.knownCostMargin??0)-(b.knownCostMargin??0)).slice(0,10) },
    capital: { totalKnownCapital: capitalRows.length?capitalRows.reduce((sum,row)=>sum+(row.knownCapital??0),0):null, listings:capitalRows.length, byAge:capitalByAge, stale:capitalRows.filter(row=>(row.ageDays??0)>90).sort((a,b)=>(b.knownCapital??0)-(a.knownCapital??0)).slice(0,15) },
    job: latestOrderJob,
    latestSuccessfulSync: latestCompletedOrderJob?.completedAt ?? null,
  };
}
