import type {Express,Request,Response,NextFunction} from 'express';
import {randomUUID,randomBytes,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {HttpError,type Store} from './store.ts';
import type {Product,WorkspaceState} from '../shared/types.ts';

type Ctx={workspaceId:string;user:{id:string;name:string;email:string;visitor:boolean}};
type Deps={store:Store;requireContext:(req:Request,res:Response,next:NextFunction)=>unknown;getContext:(res:Response)=>Ctx;broadcast:(id:string,state:WorkspaceState)=>void;env:Record<string,string|undefined>;fetcher:typeof fetch;secret:string;appUrl:string};
const text=(value:unknown,max=20000)=>typeof value==='string'&&value.length<=max?value.trim():'';
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const safeUrl=(value:unknown)=>{if(!value)return'';try{const url=new URL(String(value));return['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return'';}};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

export function registerAccountFlows(app:Express,d:Deps){
  const {store,requireContext,getContext,broadcast,env,fetcher,secret,appUrl}=d;
  store.db.exec(`CREATE TABLE IF NOT EXISTS applications(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,type TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,date TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pinterest_states(state_hash TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pinterest_connections(workspace_id TEXT PRIMARY KEY,credentials TEXT NOT NULL,expires_at INTEGER NOT NULL,scope TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pinterest_imports(workspace_id TEXT NOT NULL,pin_id TEXT NOT NULL,product_id TEXT NOT NULL,PRIMARY KEY(workspace_id,pin_id));`);
  const available=!!(env.PINTEREST_CLIENT_ID&&env.PINTEREST_CLIENT_SECRET);
  const redirectUri=env.PINTEREST_REDIRECT_URI||`${appUrl}/api/integrations/pinterest/callback`;
  const encryptionKey=createHash('sha256').update(`${secret}:pinterest`).digest();
  const encrypt=(value:unknown)=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey,iv);const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');};
  const decrypt=(value:string)=>{const buffer=Buffer.from(value,'base64'),decipher=createDecipheriv('aes-256-gcm',encryptionKey,buffer.subarray(0,12));decipher.setAuthTag(buffer.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(buffer.subarray(28)),decipher.final()]).toString('utf8')) as {access_token:string;refresh_token?:string};};
  const requireConfigured=()=>{if(!available)throw new HttpError(503,'Pinterest is not connected to this service yet.');};
  const account=(res:Response)=>{const ctx=getContext(res);if(ctx.user.visitor)throw new HttpError(401,'Sign in before connecting Pinterest.');return ctx;};
  const connection=(id:string)=>store.db.prepare('SELECT credentials,expires_at,scope FROM pinterest_connections WHERE workspace_id=?').get(id) as {credentials:string;expires_at:number;scope:string}|undefined;
  async function exchange(parameters:URLSearchParams){
    const response=await fetcher('https://api.pinterest.com/v5/oauth/token',{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${env.PINTEREST_CLIENT_ID}:${env.PINTEREST_CLIENT_SECRET}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body:parameters,signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new HttpError(502,'Pinterest could not complete authorization. Reconnect and try again.');const payload=record(await response.json());if(!text(payload.access_token,10000)||!Number.isFinite(Number(payload.expires_in)))throw new HttpError(502,'Pinterest returned an invalid authorization response.');return payload;
  }
  function saveConnection(id:string,payload:Record<string,unknown>,previous?:{access_token:string;refresh_token?:string},scope=''){
    const expiry=store.now().getTime()+Number(payload.expires_in)*1000;
    store.db.prepare('INSERT INTO pinterest_connections(workspace_id,credentials,expires_at,scope) VALUES(?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET credentials=excluded.credentials,expires_at=excluded.expires_at,scope=excluded.scope').run(id,encrypt({access_token:payload.access_token,refresh_token:payload.refresh_token||previous?.refresh_token}),expiry,text(payload.scope,2000)||scope);
  }
  const refreshes=new Map<string,Promise<string>>();
  const generations=new Map<string,number>();
  async function access(id:string,force=false):Promise<string>{
    const row=connection(id);if(!row)throw new HttpError(401,'Connect your Pinterest account first.');let saved:{access_token:string;refresh_token?:string};try{saved=decrypt(row.credentials);}catch{throw new HttpError(401,'Reconnect your Pinterest account.');}
    if(!force&&row.expires_at>store.now().getTime()+60000)return saved.access_token;
    if(!saved.refresh_token)throw new HttpError(401,'Your Pinterest connection expired. Reconnect to continue.');
    const running=refreshes.get(id);if(running)return running;
    const generation=generations.get(id)||0;
    const promise=(async()=>{const payload=await exchange(new URLSearchParams({grant_type:'refresh_token',refresh_token:saved.refresh_token!}));if((generations.get(id)||0)!==generation||connection(id)?.credentials!==row.credentials)throw new HttpError(401,'Your Pinterest connection changed. Connect again to continue.');saveConnection(id,payload,saved,row.scope);return String(payload.access_token);})();refreshes.set(id,promise);try{return await promise;}finally{refreshes.delete(id);}
  }
  async function pinterest(id:string,route:string){
    requireConfigured();let token=await access(id);let response=await fetcher(`https://api.pinterest.com/v5/${route}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});
    if(response.status===401){token=await access(id,true);response=await fetcher(`https://api.pinterest.com/v5/${route}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});}
    if(!response.ok)throw new HttpError(response.status===401?401:502,'Pinterest could not load this content. Check your connection and permissions.');return record(await response.json());
  }
  const numericId=(value:unknown)=>{const id=text(value,100);if(!/^\d+$/.test(id))throw new HttpError(400,'Invalid Pinterest reference.');return id;};
  const pagination=(req:Request)=>{const params=new URLSearchParams({page_size:'100'});const bookmark=text(req.query.bookmark,2000);if(bookmark)params.set('bookmark',bookmark);return params;};
  const pinMedia=(value:unknown)=>({images:Object.fromEntries(Object.entries(record(record(value).images)).filter(([key])=>/^[A-Za-z0-9x_-]{1,40}$/.test(key)).map(([key,item])=>{const image=record(item);return[key,{url:safeUrl(image.url),width:Number(image.width)||0,height:Number(image.height)||0}];}))});
  app.get('/api/applications',requireContext,(_req,res)=>{const rows=store.db.prepare('SELECT id,type,status,payload,date FROM applications WHERE workspace_id=? ORDER BY date DESC').all(getContext(res).workspaceId) as {id:string;type:string;status:string;payload:string;date:string}[];res.json({applications:rows.map(row=>({...JSON.parse(row.payload),id:row.id,type:row.type,status:row.status,date:row.date,updatedAt:row.date}))});});
  app.post('/api/applications',requireContext,(req,res)=>{
    const body=record(req.body),type=text(body.type,30);if(!['designer','education','enterprise','supplier'].includes(type))throw new HttpError(400,'Choose a supported application type.');
    for(const key of ['name','organization','email','website','message','evidenceUrl','country','course','graduationDate'])if(body[key]!==undefined&&(typeof body[key]!=='string'||String(body[key]).length>(key==='message'?20000:1000)))throw new HttpError(400,'Application fields must contain text within the allowed length.');
    const payload=Object.fromEntries(['name','organization','email','website','message','evidenceUrl','country','course','graduationDate'].map(key=>[key,text(body[key],key==='message'?20000:1000)]));
    if(!payload.name||!payload.organization||!/^\S+@\S+\.\S+$/.test(payload.email)||payload.message.length<10)throw new HttpError(400,'Provide your name, organization, email, and application details of at least 10 characters.');
    for(const key of ['website','evidenceUrl'])if(body[key]&&!safeUrl(body[key]))throw new HttpError(400,'Website and evidence links must use http or https.');
    if(payload.graduationDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(payload.graduationDate)||!Number.isFinite(Date.parse(payload.graduationDate))||new Date(payload.graduationDate).toISOString().slice(0,10)!==payload.graduationDate))throw new HttpError(400,'Use a valid graduation date.');
    const ctx=getContext(res);if(store.db.prepare("SELECT id FROM applications WHERE workspace_id=? AND type=? AND status='submitted'").get(ctx.workspaceId,type))throw new HttpError(409,'An application of this type is already awaiting review.');
    const id=randomUUID(),date=store.now().toISOString();const result=store.db.transaction(()=>{store.db.prepare('INSERT INTO applications(id,workspace_id,type,status,payload,date) VALUES(?,?,?,?,?,?)').run(id,ctx.workspaceId,type,'submitted',JSON.stringify(payload),date);return store.mutate(ctx.workspaceId,state=>{state.inbox.unshift({id:randomUUID(),title:'Application submitted',message:`Your ${type} application was recorded and is awaiting review. No approval has been granted.`,date,read:false,type:'application'});});})();broadcast(ctx.workspaceId,result.state);res.status(201).json({application:{...payload,id,type,status:'submitted',date,updatedAt:date},message:'Application recorded and awaiting review. This does not grant verification, pricing, or supplier approval.',state:result.state});
  });
  app.get('/api/integrations/pinterest/status',requireContext,(_req,res)=>{const row=connection(getContext(res).workspaceId);res.json({available,connected:!!row,...(row?{expiresAt:new Date(row.expires_at).toISOString(),scope:row.scope}:{})});});
  app.post('/api/integrations/pinterest/connect',requireContext,(_req,res)=>{
    requireConfigured();const ctx=account(res),state=randomBytes(32).toString('hex');generations.set(ctx.workspaceId,(generations.get(ctx.workspaceId)||0)+1);store.db.prepare('DELETE FROM pinterest_states WHERE expires_at<? OR workspace_id=?').run(store.now().getTime(),ctx.workspaceId);store.db.prepare('INSERT INTO pinterest_states(state_hash,workspace_id,expires_at) VALUES(?,?,?)').run(hash(state),ctx.workspaceId,store.now().getTime()+10*60*1000);
    const url=new URL('https://www.pinterest.com/oauth/');url.search=new URLSearchParams({client_id:env.PINTEREST_CLIENT_ID!,redirect_uri:redirectUri,response_type:'code',scope:'boards:read,pins:read',state}).toString();res.json({url:url.href});
  });
  app.get('/api/integrations/pinterest/callback',requireContext,async(req,res)=>{
    requireConfigured();const ctx=account(res),state=text(req.query.state,100),code=text(req.query.code,3000);
    if(!/^[a-f0-9]{64}$/.test(state))throw new HttpError(400,'Pinterest authorization expired or did not match this account.');
    const pending=store.db.prepare('SELECT workspace_id,expires_at FROM pinterest_states WHERE state_hash=?').get(hash(state)) as {workspace_id:string;expires_at:number}|undefined;
    if(!pending||pending.workspace_id!==ctx.workspaceId||pending.expires_at<store.now().getTime())throw new HttpError(403,'Pinterest authorization expired or did not match this account.');
    store.db.prepare('DELETE FROM pinterest_states WHERE state_hash=?').run(hash(state));if(req.query.error||!code)throw new HttpError(400,'Pinterest authorization was not granted.');
    const generation=generations.get(ctx.workspaceId)||0;
    const payload=await exchange(new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:redirectUri,continuous_refresh:'true'}));if((generations.get(ctx.workspaceId)||0)!==generation)throw new HttpError(409,'Your Pinterest connection changed. Connect again to continue.');saveConnection(ctx.workspaceId,payload);
    res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");res.setHeader('Referrer-Policy','no-referrer');res.type('html').send('<!doctype html><html lang="en"><title>Pinterest connected</title><h1>Pinterest connected to monogram</h1><p>Your connection is saved securely on the server.</p><a href="/">Return to monogram</a></html>');
  });
  app.get('/api/integrations/pinterest/boards',requireContext,async(req,res)=>{const ctx=account(res),payload=await pinterest(ctx.workspaceId,`boards?${pagination(req)}`),items=Array.isArray(payload.items)?payload.items.map(value=>{const item=record(value);return{id:text(item.id,100),name:text(item.name,500),description:text(item.description),privacy:text(item.privacy,30),pin_count:Number(item.pin_count)||0};}):[];res.json({items,bookmark:text(payload.bookmark,2000)||null});});
  app.get('/api/integrations/pinterest/boards/:id/pins',requireContext,async(req,res)=>{const ctx=account(res),payload=await pinterest(ctx.workspaceId,`boards/${numericId(req.params.id)}/pins?${pagination(req)}`);res.json({items:Array.isArray(payload.items)?payload.items.map(value=>{const item=record(value);return{id:text(item.id,100),title:text(item.title,500),description:text(item.description),link:safeUrl(item.link),media:pinMedia(item.media)};}):[],bookmark:text(payload.bookmark,2000)||null});});
  app.post('/api/integrations/pinterest/import',requireContext,async(req,res)=>{
    const ctx=account(res),boardId=numericId(req.body?.boardId);let selected:Set<string>|null=null;
    if(req.body.pinIds!==undefined){if(!Array.isArray(req.body.pinIds)||req.body.pinIds.length>1000)throw new HttpError(400,'Choose at most 1,000 pins.');selected=new Set(req.body.pinIds.map(numericId));if(!selected.size)throw new HttpError(400,'Choose pins to import.');}
    const pins:Record<string,unknown>[]=[];let bookmark='';
    for(let page=0;page<50;page++){const query=new URLSearchParams({page_size:'100'});if(bookmark)query.set('bookmark',bookmark);const payload=await pinterest(ctx.workspaceId,`boards/${boardId}/pins?${query}`);for(const value of Array.isArray(payload.items)?payload.items:[]){const pin=record(value);if(!selected||selected.has(text(pin.id,100)))pins.push(pin);}bookmark=text(payload.bookmark,2000);if(!bookmark||(selected&&pins.length===selected.size))break;if(page===49)throw new HttpError(400,'This board is large. Select specific pins to import.');}
    if(selected&&pins.length!==selected.size)throw new HttpError(400,'Some selected pins are no longer available in this board.');let imported=0,duplicates=0;
    const result=store.mutate(ctx.workspaceId,state=>{for(const pin of pins){const pinId=numericId(pin.id),id=`pinterest-${pinId}`,sourceUrl=`https://www.pinterest.com/pin/${pinId}/`;if(state.products.some(product=>product.id===id||product.sourceUrl===sourceUrl)){duplicates++;continue;}const images=record(record(pin.media).images);const preferred=record(images['600x']||images.originals||Object.values(images)[0]);const product:Product={id,name:text(pin.title,500)||'Pinterest reference',brand:'',category:'Reference',type:'Material',image:safeUrl(preferred.url),color:'#b8ada0',price:0,description:text(pin.description,20000),specs:{Source:'Pinterest'},variants:[],sourceUrl,custom:true};state.products.push(product);if(state.libraries[0])state.libraries[0].productIds.push(id);store.db.prepare('INSERT OR REPLACE INTO pinterest_imports(workspace_id,pin_id,product_id) VALUES(?,?,?)').run(ctx.workspaceId,pinId,id);imported++;}});broadcast(ctx.workspaceId,result.state);res.json({imported,duplicates,state:result.state});
  });
  app.delete('/api/integrations/pinterest/disconnect',requireContext,(_req,res)=>{const ctx=account(res);generations.set(ctx.workspaceId,(generations.get(ctx.workspaceId)||0)+1);store.db.transaction(()=>{store.db.prepare('DELETE FROM pinterest_connections WHERE workspace_id=?').run(ctx.workspaceId);store.db.prepare('DELETE FROM pinterest_states WHERE workspace_id=?').run(ctx.workspaceId);})();res.json({connected:false,message:'Saved connection removed. You can also revoke monogram access in Pinterest settings.'});});
}
