import type {Express,RequestHandler,Response} from 'express';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Product,WorkspaceState,SupplierRequest} from '../shared/types.ts';
import type {SupplierProfile,SupplierProduct,SupplierCollection,SupplierGalleryItem,SupplierLead,SupplierState,SupplierEditableState,SupplierRequestInput,PublicShowroomData} from '../shared/supplier.ts';
import {supplierLeadStatuses} from '../shared/supplier.ts';
import {makeState} from '../shared/defaults.ts';
import {Store,HttpError,validateState} from './store.ts';

type Context={workspaceId:string;user:{id:string;name:string;email:string;visitor:boolean;image?:string|null}};
export type SupplierRouteDependencies={store:Store;requireContext:RequestHandler;getContext:(res:Response)=>Context;broadcast:(workspaceId:string,state:WorkspaceState)=>void;now?:()=>Date;uploadDir?:string};
type AccountRow={workspace_id:string;slug:string|null;profile_json:string;revision:number;updated_at:string};
type DataRow={id:string;data_json:string;requester_workspace_id?:string|null;request_id?:string|null};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const str=(v:unknown,max=10000)=>typeof v==='string'&&v.length<=max;
const safe=(v:unknown,depth=0):boolean=>depth<40&&(Array.isArray(v)?v.every(x=>safe(x,depth+1)):!object(v)||Object.entries(v).every(([k,x])=>!['__proto__','prototype','constructor'].includes(k)&&safe(x,depth+1)));
const id=(v:unknown):v is string=>str(v,200)&&String(v).length>0;
const email=(v:unknown)=>str(v,320)&&/^\S+@\S+\.\S+$/.test(String(v));
const web=(v:unknown)=>{if(!str(v,4000))return false;if(!v)return true;try{const u=new URL(v as string);return['https:','http:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}};
const asset=(v:unknown)=>str(v,10000)&&(!v||web(v)||/^\/(?:assets|uploads)\/[\w.-]+$/.test(String(v)));
const slug=(v:unknown):v is string=>typeof v==='string'&&/^[a-z0-9][a-z0-9-]{2,62}$/.test(v)&&!['api','supplier','showroom','admin','assets','uploads','login','signup'].includes(v);
const list=(v:unknown,max:number):v is unknown[]=>Array.isArray(v)&&v.length<=max;
const ids=(v:unknown,max=1000):v is string[]=>list(v,max)&&v.every(id)&&new Set(v).size===v.length;
const iso=(v:unknown)=>typeof v==='string'&&(!v||(!Number.isNaN(Date.parse(v))&&v.length<50));
function ensure(condition:unknown,message:string):asserts condition{if(!condition)throw new HttpError(400,message);}
const pick=<T extends object,K extends keyof T>(value:T,keys:K[]):Pick<T,K>=>Object.fromEntries(keys.map(key=>[key,value[key]])) as Pick<T,K>;

function validateEditable(input:unknown):asserts input is SupplierEditableState{
  ensure(safe(input)&&object(input),'Invalid supplier data.');
  const profile=input.profile;
  ensure(profile===null||(object(profile)&&['businessName','description','location','contactName','phone','internalNotes'].every(k=>str(profile[k],k==='description'||k==='internalNotes'?20000:500))&&String(profile.businessName).trim()&&slug(profile.slug)&&web(profile.website)&&asset(profile.logo)&&asset(profile.cover)&&email(profile.contactEmail)&&typeof profile.published==='boolean'),'Enter a business name, a unique URL slug and a valid contact email.');
  ensure(list(input.products,2000)&&list(input.collections,300)&&list(input.gallery,1000),'Supplier catalog limits exceeded.');
  ensure(input.products.every(p=>object(p)&&typeof p.published==='boolean'&&str(p.privateNotes,20000)&&str(p.createdAt,100)&&str(p.updatedAt,100)),'Invalid supplier product.');
  // Reuse the application's complete product validation, including URL and PBR checks.
  validateState(makeState(input.products as unknown as Product[]));
  const productIds=new Set((input.products as unknown as SupplierProduct[]).map(p=>p.id));
  ensure(input.collections.every(c=>object(c)&&id(c.id)&&str(c.name,300)&&String(c.name).trim()&&str(c.description,20000)&&asset(c.cover)&&typeof c.published==='boolean'&&ids(c.productIds)&&c.productIds.every(p=>productIds.has(p))),'Invalid collection or unknown product reference.');
  ensure(input.gallery.every(g=>object(g)&&id(g.id)&&str(g.title,500)&&String(g.title).trim()&&str(g.description,20000)&&asset(g.image)&&String(g.image).length>0&&typeof g.published==='boolean'&&ids(g.productIds)&&g.productIds.every(p=>productIds.has(p))),'Invalid gallery item or unknown product reference.');
  for(const entries of [input.products,input.collections,input.gallery])ensure(new Set(entries.map(value=>(value as {id:string}).id)).size===entries.length,'Duplicate catalog identifiers are not allowed.');
}
function validateRequest(input:unknown):asserts input is SupplierRequestInput{
  ensure(safe(input)&&object(input)&&['quote','sample','general'].includes(String(input.type))&&str(input.name,300)&&String(input.name).trim()&&email(input.email)&&str(input.company,500)&&str(input.phone,100)&&str(input.message,20000)&&String(input.message).trim()&&ids(input.productIds,100),'Provide a name, email, request message and valid product selections.');
}
function publicProduct(product:SupplierProduct):Product{
  const result=pick(product,['id','name','brand','category','type','image','color','price','description','specs','variants','texture','model','sourceUrl','files','material','shape','custom','images','variantIds','modelSize','sampleKind']);
  result.variants=product.variants.map(variant=>pick(variant,['name','color','image','productId']));
  if(product.files)result.files=product.files.map(file=>pick(file,['name','url']));
  if(product.material){result.material=pick(product.material,['roughness','metalness','ior','opacity','transmission','thickness','distance','attenuationColor','normal','bumpScale','texture','roughnessMap','opacityMap','bumpMap','normalMap','textureWidth','textureHeight','textureRotation','ormMap','transmissionMap','thicknessMap','normalScale','sheen','sheenColor','sheenRoughness','clearcoat','clearcoatRoughness','specularIntensity','aoMapIntensity','color']);if(product.material.mapTransforms)result.material.mapTransforms=Object.fromEntries((['diffuse','normal','orm','transmissionThickness'] as const).flatMap(key=>{const mapping=product.material?.mapTransforms?.[key];return mapping?[[key,pick(mapping,['x','y','rotation'])]]:[];}));}
  return result;
}

export class SupplierRepository{
  readonly db:Store['db'];readonly now:()=>Date;
  constructor(readonly store:Store,now?:()=>Date){this.db=store.db;this.now=now||store.now;this.db.exec(`
    CREATE TABLE IF NOT EXISTS supplier_accounts(workspace_id TEXT PRIMARY KEY,slug TEXT UNIQUE,profile_json TEXT NOT NULL DEFAULT 'null',revision INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS supplier_products(workspace_id TEXT NOT NULL,id TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(workspace_id,id));
    CREATE TABLE IF NOT EXISTS supplier_collections(workspace_id TEXT NOT NULL,id TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(workspace_id,id));
    CREATE TABLE IF NOT EXISTS supplier_gallery(workspace_id TEXT NOT NULL,id TEXT NOT NULL,data_json TEXT NOT NULL,PRIMARY KEY(workspace_id,id));
    CREATE TABLE IF NOT EXISTS supplier_leads(workspace_id TEXT NOT NULL,id TEXT NOT NULL,requester_workspace_id TEXT,request_id TEXT,data_json TEXT NOT NULL,PRIMARY KEY(workspace_id,id));
    CREATE INDEX IF NOT EXISTS supplier_lead_requester ON supplier_leads(requester_workspace_id);
  `);}
  private account(workspaceId:string):AccountRow{this.db.prepare('INSERT OR IGNORE INTO supplier_accounts(workspace_id,updated_at) VALUES(?,?)').run(workspaceId,this.now().toISOString());return this.db.prepare('SELECT * FROM supplier_accounts WHERE workspace_id=?').get(workspaceId) as AccountRow;}
  private rows<T>(table:string,workspaceId:string):T[]{return(this.db.prepare(`SELECT data_json FROM ${table} WHERE workspace_id=? ORDER BY rowid`).all(workspaceId) as DataRow[]).map(row=>JSON.parse(row.data_json) as T);}
  get(workspaceId:string):SupplierState{const row=this.account(workspaceId);return{revision:row.revision,profile:JSON.parse(row.profile_json),products:this.rows('supplier_products',workspaceId),collections:this.rows('supplier_collections',workspaceId),gallery:this.rows('supplier_gallery',workspaceId),leads:this.rows<SupplierLead>('supplier_leads',workspaceId).reverse(),updatedAt:row.updated_at};}
  private check(workspaceId:string,baseRevision:unknown){ensure(Number.isInteger(baseRevision)&&Number(baseRevision)>=0,'baseRevision is required.');if(this.account(workspaceId).revision!==baseRevision)throw new HttpError(409,'Your supplier workspace changed. Reload before saving.');}
  private bump(workspaceId:string){this.db.prepare('UPDATE supplier_accounts SET revision=revision+1,updated_at=? WHERE workspace_id=?').run(this.now().toISOString(),workspaceId);}
  save(workspaceId:string,input:unknown,baseRevision:unknown):SupplierState{
    validateEditable(input);
    return this.db.transaction(()=>{this.check(workspaceId,baseRevision);const now=this.now().toISOString();
      const existing=new Map(this.rows<SupplierProduct>('supplier_products',workspaceId).map(p=>[p.id,p]));
      const profile=input.profile;
      try{this.db.prepare('UPDATE supplier_accounts SET slug=?,profile_json=? WHERE workspace_id=?').run(profile?.slug||null,JSON.stringify(profile),workspaceId);}catch(error){if(String(error).includes('UNIQUE'))throw new HttpError(409,'That showroom URL is already in use.');throw error;}
      for(const [table,values] of [['supplier_products',input.products.map(p=>({...p,createdAt:existing.get(p.id)?.createdAt||now,updatedAt:now}))],['supplier_collections',input.collections],['supplier_gallery',input.gallery]] as const){this.db.prepare(`DELETE FROM ${table} WHERE workspace_id=?`).run(workspaceId);const insert=this.db.prepare(`INSERT INTO ${table}(workspace_id,id,data_json) VALUES(?,?,?)`);for(const value of values)insert.run(workspaceId,value.id,JSON.stringify(value));}
      this.bump(workspaceId);return this.get(workspaceId);
    })();
  }
  ownerForSlug(value:string){if(!slug(value))throw new HttpError(404,'Showroom not found.');const row=this.db.prepare('SELECT * FROM supplier_accounts WHERE slug=?').get(value) as AccountRow|undefined;if(!row)throw new HttpError(404,'Showroom not found.');const profile=JSON.parse(row.profile_json) as SupplierProfile|null;if(!profile?.published)throw new HttpError(404,'Showroom not found.');return row.workspace_id;}
  showroom(value:string,rewriteAssets=true):PublicShowroomData{
    const state=this.get(this.ownerForSlug(value)),profile=state.profile!;
    const products=state.products.filter(p=>p.published).map(publicProduct),allowed=new Set(products.map(p=>p.id));
    const result:PublicShowroomData={profile:pick(profile,['businessName','slug','description','website','location','logo','cover']),products,collections:state.collections.filter(c=>c.published).map(c=>({...pick(c,['id','name','description','cover','published']),productIds:c.productIds.filter(id=>allowed.has(id))})),gallery:state.gallery.filter(g=>g.published).map(g=>({...pick(g,['id','title','description','image','published']),productIds:g.productIds.filter(id=>allowed.has(id))})),updatedAt:state.updatedAt,implementation:'local-showroom'};
    if(!rewriteAssets)return result;
    const rewrite=(v:unknown):unknown=>typeof v==='string'&&/^\/uploads\/[\w.-]+$/.test(v)?`/api/showrooms/${value}/assets/${v.slice('/uploads/'.length)}`:Array.isArray(v)?v.map(rewrite):object(v)?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,rewrite(x)])):v;
    return rewrite(result) as PublicShowroomData;
  }
  canReadAsset(value:string,filename:string){if(!/^[\w.-]+$/.test(filename))return false;const owner=this.ownerForSlug(value);const upload=this.db.prepare('SELECT workspace_id FROM uploads WHERE filename=?').get(filename) as {workspace_id:string}|undefined;if(upload?.workspace_id!==owner)return false;const publicData=this.showroom(value,false),expected=`/uploads/${filename}`;const includes=(v:unknown):boolean=>v===expected||(Array.isArray(v)&&v.some(includes))||(object(v)&&Object.values(v).some(includes));return includes(publicData);}
  leadRow(workspaceId:string,leadId:string){const row=this.db.prepare('SELECT * FROM supplier_leads WHERE workspace_id=? AND id=?').get(workspaceId,leadId) as DataRow|undefined;if(!row)throw new HttpError(404,'Lead not found.');return row;}
  addLead(workspaceId:string,input:unknown,source:'showroom'|'manual',requesterWorkspaceId?:string,requestId?:string,baseRevision?:unknown){validateRequest(input);return this.db.transaction(()=>{if(source==='manual')this.check(workspaceId,baseRevision);else this.account(workspaceId);const known=new Set(this.rows<SupplierProduct>('supplier_products',workspaceId).map(p=>p.id));ensure(input.productIds.every(id=>known.has(id)),'Lead references an unknown supplier product.');const now=this.now().toISOString();const lead:SupplierLead={...pick(input,['type','name','email','company','phone','message','productIds']),id:randomUUID(),status:'new',notes:'',followUpAt:'',source,replies:[],createdAt:now,updatedAt:now};this.db.prepare('INSERT INTO supplier_leads(workspace_id,id,requester_workspace_id,request_id,data_json) VALUES(?,?,?,?,?)').run(workspaceId,lead.id,requesterWorkspaceId||null,requestId||null,JSON.stringify(lead));this.bump(workspaceId);return lead;})();}
  updateLead(workspaceId:string,leadId:string,input:unknown,baseRevision:unknown){ensure(safe(input)&&object(input)&&Object.keys(input).every(k=>['status','notes','followUpAt'].includes(k))&&(input.status===undefined||supplierLeadStatuses.includes(input.status as SupplierLead['status']))&&(input.notes===undefined||str(input.notes,30000))&&(input.followUpAt===undefined||iso(input.followUpAt)),'Invalid lead status, notes or follow-up date.');return this.db.transaction(()=>{this.check(workspaceId,baseRevision);const row=this.leadRow(workspaceId,leadId),lead={...JSON.parse(row.data_json),...input,updatedAt:this.now().toISOString()} as SupplierLead;this.db.prepare('UPDATE supplier_leads SET data_json=? WHERE workspace_id=? AND id=?').run(JSON.stringify(lead),workspaceId,leadId);this.bump(workspaceId);return lead;})();}
  reply(workspaceId:string,leadId:string,message:unknown,baseRevision:unknown){ensure(str(message,20000)&&String(message).trim(),'Enter a reply of up to 20,000 characters.');return this.db.transaction(()=>{this.check(workspaceId,baseRevision);const row=this.leadRow(workspaceId,leadId),lead=JSON.parse(row.data_json) as SupplierLead;const reply={id:randomUUID(),message:String(message).trim(),createdAt:this.now().toISOString(),delivery:row.requester_workspace_id?'internal' as const:'recorded' as const};lead.replies.push(reply);lead.status=lead.status==='new'?'contacted':lead.status;lead.updatedAt=reply.createdAt;this.db.prepare('UPDATE supplier_leads SET data_json=? WHERE workspace_id=? AND id=?').run(JSON.stringify(lead),workspaceId,leadId);this.bump(workspaceId);return{lead,reply,requesterWorkspaceId:row.requester_workspace_id,requestId:row.request_id};})();}
}

export function registerSupplierRoutes(app:Express,deps:SupplierRouteDependencies){
  const{store,requireContext,getContext,broadcast}=deps;const repository=new SupplierRepository(store,deps.now);const now=repository.now;
  const response=(res:Response)=>{const ctx=getContext(res);return{state:repository.get(ctx.workspaceId),workspaceId:ctx.workspaceId};};
  const verifyWorkspace=(body:unknown,res:Response)=>{if(object(body)&&body.workspaceId!==undefined&&body.workspaceId!==getContext(res).workspaceId)throw new HttpError(403,'This supplier workspace belongs to another account.');};
  app.get('/api/supplier',requireContext,(_req,res)=>res.json(response(res)));
  app.put('/api/supplier',requireContext,(req,res)=>{verifyWorkspace(req.body,res);const ctx=getContext(res),state=repository.save(ctx.workspaceId,req.body?.state,req.body?.baseRevision);res.json({state,workspaceId:ctx.workspaceId});});
  app.post('/api/supplier/leads',requireContext,(req,res)=>{verifyWorkspace(req.body,res);const ctx=getContext(res);const profile=repository.get(ctx.workspaceId).profile;if(!profile)throw new HttpError(409,'Create your supplier profile first.');repository.addLead(ctx.workspaceId,req.body?.lead,'manual',undefined,undefined,req.body?.baseRevision);res.status(201).json(response(res));});
  app.patch('/api/supplier/leads/:id',requireContext,(req,res)=>{verifyWorkspace(req.body,res);repository.updateLead(getContext(res).workspaceId,String(req.params.id),req.body?.patch,req.body?.baseRevision);res.json(response(res));});
  app.post('/api/supplier/leads/:id/replies',requireContext,(req,res)=>{verifyWorkspace(req.body,res);const ctx=getContext(res);const result=store.db.transaction(()=>{const reply=repository.reply(ctx.workspaceId,String(req.params.id),req.body?.message,req.body?.baseRevision);let state:WorkspaceState|undefined;if(reply.requesterWorkspaceId){state=store.mutate(reply.requesterWorkspaceId,workspace=>{const request=workspace.requests.find(item=>item.id===reply.requestId);if(request)request.status='replied';workspace.inbox.unshift({id:randomUUID(),title:`${repository.get(ctx.workspaceId).profile?.businessName||'Supplier'} replied`,message:reply.reply.message,date:now().toISOString(),read:false,type:'supplier-reply'});}).state;}return{...reply,state};})();if(result.state&&result.requesterWorkspaceId)broadcast(result.requesterWorkspaceId,result.state);res.status(201).json({...response(res),delivery:result.reply.delivery,message:result.reply.delivery==='internal'?'Reply delivered to the requester’s monogram inbox. No email was sent.':'Reply recorded in this lead. No external message was sent.'});});
  app.get('/api/supplier/request-history',requireContext,(_req,res)=>{const ctx=getContext(res);const rows=store.db.prepare('SELECT data_json,workspace_id FROM supplier_leads WHERE requester_workspace_id=? ORDER BY rowid DESC').all(ctx.workspaceId) as (DataRow&{workspace_id:string})[];res.json({requests:rows.map(row=>{const lead=JSON.parse(row.data_json) as SupplierLead;return{...pick(lead,['id','type','message','productIds','status','replies','createdAt','updatedAt']),businessName:repository.get(row.workspace_id).profile?.businessName||'Supplier'};})});});
  app.get('/api/showrooms/:slug/assets/:filename',(req,res)=>{const value=String(req.params.slug),filename=String(req.params.filename);if(!deps.uploadDir||!repository.canReadAsset(value,filename))throw new HttpError(404,'Published asset not found.');res.setHeader('Cache-Control','public,max-age=60');res.sendFile(path.resolve(deps.uploadDir,filename));});
  app.get('/api/showrooms/:slug',(req,res)=>res.json(repository.showroom(String(req.params.slug))));
  app.post('/api/showrooms/:slug/requests',requireContext,(req,res)=>{validateRequest(req.body);const ctx=getContext(res),value=String(req.params.slug),owner=repository.ownerForSlug(value),showroom=repository.showroom(value);const allowed=new Set(showroom.products.map(p=>p.id));if(req.body.productIds.some((id:string)=>!allowed.has(id)))throw new HttpError(400,'Choose products published in this showroom.');const result=store.db.transaction(()=>{const requestId=randomUUID(),lead=repository.addLead(owner,req.body,'showroom',ctx.workspaceId,requestId);let requesterState=store.mutate(ctx.workspaceId,workspace=>{for(const product of showroom.products.filter(p=>req.body.productIds.includes(p.id)))if(!workspace.products.some(p=>p.id===product.id))workspace.products.push(product);const request:SupplierRequest={id:requestId,type:req.body.type==='sample'?'sample':'quote',productIds:lead.productIds,name:lead.name,email:lead.email,message:lead.message,status:'submitted',date:lead.createdAt,supplier:showroom.profile.businessName};workspace.requests.unshift(request);}).state;const supplierState=store.mutate(owner,workspace=>{workspace.inbox.unshift({id:randomUUID(),title:'New showroom request',message:`${lead.name} requested ${lead.type==='general'?'information':lead.type==='sample'?'samples':'a quote'}. Open Supplier Console to follow up.`,date:lead.createdAt,read:false,type:'supplier-lead'});}).state;if(owner===ctx.workspaceId)requesterState=supplierState;return{lead,requesterState,supplierState};})();broadcast(ctx.workspaceId,result.requesterState);if(owner!==ctx.workspaceId)broadcast(owner,result.supplierState);res.status(201).json({requestId:result.lead.id,delivery:'internal',message:'Request delivered to this supplier’s monogram console. No email was sent.',state:result.requesterState});});
  return repository;
}
