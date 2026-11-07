import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { checkSavedDraft,evidenceHash } from '../lib/card-saved-draft-check.ts';
async function main(){
const [expectedFile,captureFile,outputFile,screenshotFile]=process.argv.slice(2);
if(!expectedFile||!captureFile||!outputFile)throw Error('Use EXPECTED.json CAPTURE.json NEW_REPORT.json [VISUALLY_REVIEWED_SCREENSHOT]');
const start=performance.now(),startedAt=new Date().toISOString();
const expected=JSON.parse(await fs.readFile(expectedFile,'utf8')),capture=JSON.parse(await fs.readFile(captureFile,'utf8'));
if(capture.visual){
  if(!screenshotFile)throw Error('Visual attestation requires retained screenshot file');
  const {createHash}=await import('node:crypto');
  if(createHash('sha256').update(await fs.readFile(screenshotFile)).digest('hex')!==capture.visual.screenshotSha256)throw Error('Visual screenshot hash mismatch');
}
const report=checkSavedDraft(expected,capture);
await fs.writeFile(outputFile,JSON.stringify({...report,timing:{startedAt,finishedAt:new Date().toISOString(),durationMs:performance.now()-start},sourceFiles:{expectedFile,captureFile,screenshotFile},rawAXHash:evidenceHash(capture.ax)},null,2),{flag:'wx'});
console.log(JSON.stringify({draftId:report.draftId,allChecksPassed:report.allChecksPassed,photoIdentityVerified:report.photoIdentityVerified,exceptions:report.checks.filter(c=>c.status!=='pass'),outputFile},null,2));
if(!report.allChecksPassed)process.exitCode=2;
}
void main().catch(error=>{console.error(error instanceof Error?error.message:'Saved draft check failed');process.exitCode=1;});
