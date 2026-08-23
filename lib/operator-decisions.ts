export const operatorDecisionValues = ["follow_recommendation", "keep_current", "defer"] as const;
export type OperatorDecisionValue = typeof operatorDecisionValues[number];

export function isOperatorDecision(value:string):value is OperatorDecisionValue{return operatorDecisionValues.includes(value as OperatorDecisionValue);}
export function observationWindowDays(recommendedAction:string){if(/PRICE|OFFER/.test(recommendedAction))return 30;if(/TITLE|DISCOVERABILITY/.test(recommendedAction))return 60;if(/SOURCING|CAPITAL|STALE/.test(recommendedAction))return 90;return 30;}
export function operatorDecisionLabel(value:OperatorDecisionValue,recommendedAction:string){return value==="follow_recommendation"?`YES — ${recommendedAction}`:value==="keep_current"?"KEEP CURRENT APPROACH":"DECIDE LATER";}
