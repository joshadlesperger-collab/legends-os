import auditData from "../data/card-catalog/topps-chrome-basketball-2025-26-audit.json";
import registryData from "../data/card-catalog/source-registry.json";
import trialData from "../data/card-catalog/cardhedge-trial.json";
import { cardCatalog } from "./card-knowledge-store";
import { validateCatalogAudit } from "./card-catalog-audit";
export const {catalogAudit,sourceRegistry}=validateCatalogAudit(cardCatalog,auditData,registryData);
export const cardHedgeTrial=trialData;
