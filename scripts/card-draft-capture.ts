import {readFileSync,writeFileSync} from 'node:fs';
import {captureDraftSnapshot} from '../lib/card-saved-draft-check.ts';
// No network, writes only a new requested evidence packet; never overwrite a previous capture.
const [axFile,observationsFile,output]=process.argv.slice(2);
if(!axFile||!observationsFile||!output)throw Error('Usage: card-draft-capture.ts AX_FILE OBSERVATIONS_JSON NEW_CAPTURE_JSON');
const capture=captureDraftSnapshot(readFileSync(axFile,'utf8'),JSON.parse(readFileSync(observationsFile,'utf8')));
writeFileSync(output,JSON.stringify(capture,null,2),{flag:'wx'});
console.log('Capture assembled from retained snapshot. Run draft-verify; this does not certify readiness.');
