/** Local runtime cutover boundary. No environment variable can override a retired root. */
const fs=require('node:fs'),path=require('node:path');
function object(file){let st;try{st=fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}if(!st.isFile()||st.isSymbolicLink()||st.size>65536)throw Error('Invalid V2 runtime relocation marker');let value;try{value=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('Unreadable V2 runtime relocation marker');}if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid V2 runtime relocation marker');return value;}
/** @param {string} [root] */
function assertV2RuntimeRoot(root=process.cwd()){
 const requested=path.resolve(root);if(object(path.join(requested,'.v2-runtime-retired.json')))throw Error('This V2 runtime is retired; use the recorded local operational checkout. Writes are refused.');
 const m=object(path.join(requested,'.v2-runtime-location.json'));if(!m)return{migrated:false,activeRoot:requested};
 if(m.version!==1||m.kind!=='v2-local-runtime-location'||typeof m.activeRoot!=='string'||!path.isAbsolute(m.activeRoot)||typeof m.sourceRoot!=='string'||!path.isAbsolute(m.sourceRoot)||typeof m.migrationId!=='string'||!m.migrationId.trim())throw Error('Invalid V2 local runtime location manifest');
 const actual=fs.realpathSync(requested),active=fs.realpathSync(m.activeRoot),equal=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
 if(!equal(actual,requested)||!equal(active,path.resolve(m.activeRoot))||!equal(actual,active)||equal(actual,path.resolve(m.sourceRoot))||actual.split(/[\\/]/).some(p=>/^onedrive(?:$|[ -])/i.test(p)))throw Error('V2 writes require the exact recorded non-OneDrive local runtime; aliases and retired roots are refused.');
 return{migrated:true,activeRoot:actual};
}
exports.assertV2RuntimeRoot=assertV2RuntimeRoot;
