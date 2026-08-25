
import express from "express";
import multer from "multer";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as actual from "@actual-app/api";

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express();
const PORT=Number(process.env.PORT||3000);
const DATA_DIR=process.env.DATA_DIR||"/app/data";
const PROFILE_DIR=path.join(DATA_DIR,"profiles");
const SETTINGS_FILE=path.join(DATA_DIR,"settings.json");
const ACTUAL_CACHE=path.join(DATA_DIR,"actual-cache");
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:20*1024*1024}});

app.use(express.json({limit:"5mb"}));
app.use(express.static(path.join(__dirname,"public")));

const clean=v=>String(v??"").replace(/^\uFEFF/,"").trim();
const safeId=v=>clean(v).toLowerCase().replace(/[^a-z0-9_-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,80);

async function ensureData(){
  await fs.mkdir(PROFILE_DIR,{recursive:true});
  await fs.mkdir(ACTUAL_CACHE,{recursive:true});
  try{await fs.access(SETTINGS_FILE)}catch{
    await fs.writeFile(SETTINGS_FILE,JSON.stringify({actual:{serverURL:"",syncId:"",password:"",encryptionPassword:"",accountMappings:{}}},null,2),{mode:0o600});
  }
}
async function readSettings(){await ensureData();return JSON.parse(await fs.readFile(SETTINGS_FILE,"utf8"))}
async function writeSettings(s){await fs.writeFile(SETTINGS_FILE,JSON.stringify(s,null,2),{mode:0o600});try{await fs.chmod(SETTINGS_FILE,0o600)}catch{}}

function decode(buf){
  if(buf[0]===0xff&&buf[1]===0xfe)return new TextDecoder("utf-16le").decode(buf);
  if(buf[0]===0xfe&&buf[1]===0xff)return new TextDecoder("utf-16be").decode(buf);
  const s=buf.subarray(0,Math.min(buf.length,4096));let odd=0,even=0;
  for(let i=0;i<s.length;i++)if(s[i]===0)(i%2?odd++:even++);
  const pairs=Math.max(1,Math.floor(s.length/2));
  if(odd/pairs>.25&&odd>even*3)return new TextDecoder("utf-16le").decode(buf);
  if(even/pairs>.25&&even>odd*3)return new TextDecoder("utf-16be").decode(buf);
  return new TextDecoder("utf-8").decode(buf);
}
function parse(text,del=","){
  const rows=[];let row=[],f="",q=false;
  for(let i=0;i<text.length;i++){const c=text[i],n=text[i+1];
    if(q){if(c=='"'&&n=='"'){f+='"';i++}else if(c=='"')q=false;else f+=c}
    else if(c=='"')q=true;else if(c===del){row.push(f);f=""}
    else if(c=="\n"){row.push(f);rows.push(row);row=[];f=""}else if(c!="\r")f+=c}
  if(f.length||row.length){row.push(f);rows.push(row)}
  return rows.filter(r=>r.some(x=>clean(x)));
}
function money(v){let s=clean(v).replace(/[$£€,\s]/g,"");if(!s)return null;const p=/^\(.*\)$/.test(s);s=s.replace(/[()]/g,"");const n=Number(s);return Number.isFinite(n)?(p?-n:n):null}
function date(v,fmt){
  const s=clean(v);let m;if(!s)return null;
  if(fmt==="YYYY-MM-DD"&&/^\d{4}-\d{2}-\d{2}$/.test(s))return s;
  if(fmt==="YYYYMMDD"&&/^\d{8}$/.test(s))return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  const mons={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  if(fmt==="DD MMM YYYY"&&(m=s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/))){const mo=mons[m[2].toLowerCase()];return mo?`${m[3]}-${String(mo).padStart(2,"0")}-${String(+m[1]).padStart(2,"0")}`:null}
  if(fmt==="MM/DD/YYYY"&&(m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)))return `${m[3]}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`;
  if(fmt==="DD/MM/YYYY"&&(m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)))return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  if(fmt==="YYYY/MM/DD"&&(m=s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/)))return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
  return null;
}
function findHeader(rows,required=[]){const req=required.map(x=>clean(x).toLowerCase());return rows.findIndex(r=>{const h=r.map(x=>clean(x).toLowerCase());return req.every(x=>h.includes(x))})}
function normalize(rows,p,headerIndex=null){
  const hi=headerIndex??findHeader(rows,p.match?.requiredHeaders||[]);if(hi<0)throw Error("Profile headers not found.");
  const h=rows[hi].map(clean),low=h.map(x=>x.toLowerCase()),col=n=>low.indexOf(clean(n).toLowerCase()),m=p.mapping||{};
  const di=col(m.date),pi=col(m.description),ai=m.amount?col(m.amount):-1,db=m.debit?col(m.debit):-1,cr=m.credit?col(m.credit):-1,ii=m.importedId?col(m.importedId):-1;
  if(di<0||pi<0)throw Error("Date or description column is missing.");
  const out=[],warnings=[];
  rows.slice(hi+1).forEach((r,k)=>{if(!r.some(x=>clean(x)))return;
    const d=date(r[di],p.dateFormat),desc=clean(r[pi]).replaceAll("&amp;","&");let a=null;
    if(p.amountMode==="single"){a=money(r[ai]);if(a!==null&&p.singleAmountSign==="invert")a*=-1;if(a!==null&&p.singleAmountSign==="expenses-negative")a=-Math.abs(a);if(a!==null&&p.singleAmountSign==="expenses-positive")a=Math.abs(a)}
    else{const debit=db>=0?money(r[db]):null,credit=cr>=0?money(r[cr]):null;if(debit!==null&&debit!==0)a=-Math.abs(debit);else if(credit!==null&&credit!==0)a=Math.abs(credit)}
    if(!d||a===null||!desc){warnings.push(`Source row ${hi+k+2} skipped: invalid date, amount, or description.`);return}
    const tx={date:d,amount:a,description:desc};if(ii>=0&&clean(r[ii]))tx.importedId=clean(r[ii]);out.push(tx);
  });
  return {rows:out,warnings,headers:h,headerIndex:hi};
}
async function profiles(){
  await ensureData();const out=[];
  for(const f of (await fs.readdir(PROFILE_DIR)).filter(x=>x.endsWith(".json"))){try{out.push(JSON.parse(await fs.readFile(path.join(PROFILE_DIR,f),"utf8")))}catch{}}
  return out.sort((a,b)=>a.name.localeCompare(b.name));
}

let actualQueue=Promise.resolve();
function serializedActual(fn){const run=actualQueue.then(fn,fn);actualQueue=run.catch(()=>{});return run}
async function connectActual(){
  const s=await readSettings(),cfg=s.actual||{};
  if(!cfg.serverURL||!cfg.syncId||!cfg.password)throw Error("Actual connection is not configured.");
  await actual.init({dataDir:ACTUAL_CACHE,serverURL:cfg.serverURL,password:cfg.password});
  try{
    try{await actual.downloadBudget({syncId:cfg.syncId,password:cfg.encryptionPassword||undefined})}
    catch{await actual.downloadBudget(cfg.syncId,cfg.encryptionPassword?{password:cfg.encryptionPassword}:undefined)}
  }catch(e){try{await actual.shutdown()}catch{};throw e}
  return {cfg,s};
}
async function withActual(fn){
  return serializedActual(async()=>{const ctx=await connectActual();try{return await fn(actual,ctx.cfg,ctx.s)}finally{try{await actual.shutdown()}catch{}}});
}
function toActual(rows){return rows.map(r=>{const t={date:r.date,amount:actual.utils.amountToInteger(Number(r.amount)),payee_name:r.description};if(r.importedId)t.imported_id=r.importedId;return t})}

app.get("/api/health",(_q,r)=>r.json({ok:true,version:"3.0.0"}));
app.get("/api/profiles",async(_q,r,n)=>{try{r.json(await profiles())}catch(e){n(e)}});
app.post("/api/profiles",async(q,r,n)=>{try{const p=q.body;if(!p.name||!p.mapping?.date||!p.mapping?.description)return r.status(400).json({error:"Name, date and description mappings are required."});p.id=safeId(p.id||p.name);p.version=1;p.updatedAt=new Date().toISOString();delete p.actualAccountId;await ensureData();await fs.writeFile(path.join(PROFILE_DIR,`${p.id}.json`),JSON.stringify(p,null,2));r.json(p)}catch(e){n(e)}});
app.delete("/api/profiles/:id",async(q,r,n)=>{try{const id=safeId(q.params.id);await fs.unlink(path.join(PROFILE_DIR,`${id}.json`));const s=await readSettings();if(s.actual?.accountMappings){delete s.actual.accountMappings[id];await writeSettings(s)}r.json({ok:true})}catch(e){n(e)}});
app.get("/api/profiles/:id/export",async(q,r,n)=>{try{const id=safeId(q.params.id),c=await fs.readFile(path.join(PROFILE_DIR,`${id}.json`));r.setHeader("Content-Type","application/json");r.setHeader("Content-Disposition",`attachment; filename="${id}.json"`);r.send(c)}catch(e){n(e)}});
app.post("/api/profiles/import",upload.single("profile"),async(q,r,n)=>{try{const p=JSON.parse(q.file.buffer.toString("utf8"));p.id=safeId(p.id||p.name);delete p.actualAccountId;await ensureData();await fs.writeFile(path.join(PROFILE_DIR,`${p.id}.json`),JSON.stringify(p,null,2));r.json(p)}catch(e){n(e)}});

app.post("/api/inspect",upload.single("file"),async(q,r,n)=>{try{const rows=parse(decode(q.file.buffer)),ps=await profiles();let detected=null;for(const p of ps){const hi=findHeader(rows,p.match?.requiredHeaders||[]);if(hi>=0){detected={profile:p,headerIndex:hi};break}}let hi=detected?.headerIndex??0;if(!detected){let best=-1,score=-1;rows.slice(0,15).forEach((x,i)=>{const s=x.filter(v=>clean(v)).length;if(s>score){score=s;best=i}});hi=Math.max(0,best)}r.json({filename:q.file.originalname,detectedProfile:detected?.profile||null,headerIndex:hi,headers:(rows[hi]||[]).map(clean),sampleRows:rows.slice(hi+1,hi+7).map(x=>x.map(clean))})}catch(e){n(e)}});
app.post("/api/convert",upload.single("file"),async(q,r,n)=>{try{const p=JSON.parse(q.body.profile),rows=parse(decode(q.file.buffer),p.delimiter||",");r.json(normalize(rows,p,Number(q.body.headerIndex)))}catch(e){n(e)}});

app.get("/api/actual/settings",async(_q,r,n)=>{try{const s=await readSettings(),a=s.actual||{};r.json({serverURL:a.serverURL||"",syncId:a.syncId||"",hasPassword:!!a.password,hasEncryptionPassword:!!a.encryptionPassword,accountMappings:a.accountMappings||{}})}catch(e){n(e)}});
app.put("/api/actual/settings",async(q,r,n)=>{try{const s=await readSettings(),cur=s.actual||{},b=q.body||{};s.actual={serverURL:clean(b.serverURL??cur.serverURL),syncId:clean(b.syncId??cur.syncId),password:b.password?String(b.password):cur.password||"",encryptionPassword:b.encryptionPassword?String(b.encryptionPassword):cur.encryptionPassword||"",accountMappings:cur.accountMappings||{}};await writeSettings(s);r.json({ok:true})}catch(e){n(e)}});
app.post("/api/actual/test",async(_q,r,n)=>{try{const x=await withActual(async api=>({accounts:(await api.getAccounts()).length}));r.json({ok:true,...x})}catch(e){n(e)}});
app.get("/api/actual/accounts",async(_q,r,n)=>{try{const a=await withActual(api=>api.getAccounts());r.json(a.map(x=>({id:x.id,name:x.name,closed:!!x.closed,offbudget:!!x.offbudget})))}catch(e){n(e)}});
app.put("/api/actual/mappings/:profileId",async(q,r,n)=>{try{const s=await readSettings();s.actual=s.actual||{};s.actual.accountMappings=s.actual.accountMappings||{};const id=safeId(q.params.profileId),accountId=clean(q.body.accountId);if(accountId)s.actual.accountMappings[id]=accountId;else delete s.actual.accountMappings[id];await writeSettings(s);r.json({ok:true})}catch(e){n(e)}});
app.post("/api/actual/dry-run",async(q,r,n)=>{try{const {profileId,rows}=q.body||{};const s=await readSettings(),accountId=s.actual?.accountMappings?.[safeId(profileId)];if(!accountId)return r.status(400).json({error:"This profile is not mapped to an Actual account."});const result=await withActual(api=>api.importTransactions(accountId,toActual(rows),{dryRun:true,reimportDeleted:false,defaultCleared:true,payeeNameNormalization:"original"}));r.json({ok:true,summary:{added:result.added?.length||0,updated:result.updated?.length||0,errors:result.errors?.length||0}})}catch(e){n(e)}});
app.post("/api/actual/import",async(q,r,n)=>{try{const {profileId,rows,confirm}=q.body||{};if(confirm!==true)return r.status(400).json({error:"Import confirmation is required."});const s=await readSettings(),accountId=s.actual?.accountMappings?.[safeId(profileId)];if(!accountId)return r.status(400).json({error:"This profile is not mapped to an Actual account."});const result=await withActual(api=>api.importTransactions(accountId,toActual(rows),{dryRun:false,reimportDeleted:false,defaultCleared:true,payeeNameNormalization:"original"}));r.json({ok:true,summary:{added:result.added?.length||0,updated:result.updated?.length||0,errors:result.errors?.length||0}})}catch(e){n(e)}});

app.use((e,_q,r,_n)=>{console.error(e);r.status(500).json({error:e.message||"Internal server error",code:e.code||undefined})});
await ensureData();
app.listen(PORT,"0.0.0.0",()=>console.log(`Actual Budget CSV Importer v3.0 on ${PORT}`));
