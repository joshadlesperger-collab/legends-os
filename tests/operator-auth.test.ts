import test from "node:test";
import assert from "node:assert/strict";
import { createOperatorSession, readOperatorSession, verifyOperatorPassword } from "../lib/operator-auth.ts";

test("operator sessions are signed, attributable, expiring, and tamper resistant", async () => {
  const previousSecret=process.env.OPERATOR_SESSION_SECRET;const previousId=process.env.OPERATOR_ID;
  process.env.OPERATOR_SESSION_SECRET="test-session-secret-with-enough-entropy";process.env.OPERATOR_ID="josh";
  try{const now=new Date("2026-08-15T12:00:00Z");const token=await createOperatorSession(now);assert.equal((await readOperatorSession(token,now))?.operatorId,"josh");assert.equal(await readOperatorSession(`${token}x`,now),null);assert.equal(await readOperatorSession(token,new Date("2026-08-16T01:00:01Z")),null);}finally{if(previousSecret===undefined)delete process.env.OPERATOR_SESSION_SECRET;else process.env.OPERATOR_SESSION_SECRET=previousSecret;if(previousId===undefined)delete process.env.OPERATOR_ID;else process.env.OPERATOR_ID=previousId;}
});

test("password verification fails closed and accepts only the configured password", async () => {
  const previous=process.env.OPERATOR_PASSWORD;
  try{delete process.env.OPERATOR_PASSWORD;assert.equal(await verifyOperatorPassword("anything"),false);process.env.OPERATOR_PASSWORD="correct horse battery staple";assert.equal(await verifyOperatorPassword("wrong"),false);assert.equal(await verifyOperatorPassword("correct horse battery staple"),true);}finally{if(previous===undefined)delete process.env.OPERATOR_PASSWORD;else process.env.OPERATOR_PASSWORD=previous;}
});
