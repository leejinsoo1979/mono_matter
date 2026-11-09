import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {makeState,defaultMaterial} from '../shared/defaults.ts';
import type {Product, WorkspaceState} from '../shared/types.ts';
import {refreshBillingCredits,type BillingRow} from './billing-state.ts';
import {planLimits,workspaceUsage} from '../shared/entitlements.ts';

export class HttpError extends Error {
  constructor(public status:number, message:string){super(message);}
}
export type WorkspaceRecord={id:string;state:WorkspaceState;creditDay:string};
const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
/** Apply source corrections only to unchanged seed fields; keep local edits and selections. */
function mergeSeed(current:unknown,previous:unknown,next:unknown,initial:boolean):unknown{
  if(same(current,next))return current;
  if(!initial&&same(current,previous))return structuredClone(next);
  if(initial&&current===undefined)return structuredClone(next);
  if(object(current)&&object(next)&&(initial||object(previous))){
    const result={...current};
    for(const key of new Set([...Object.keys(next),...Object.keys(object(previous)?previous:{})])){
      const value=mergeSeed(current[key],object(previous)?previous[key]:undefined,next[key],initial);
      if(value===undefined)delete result[key];else result[key]=value;
    }
    return result;
  }
  return current;
}
export class Store {
  private catalogFileVersion='';
  constructor(public db:Database.Database, public products:Product[], public now:()=>Date, public timeZone='Asia/Seoul',private catalogPath?:string){
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,state TEXT NOT NULL,credit_day TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS visitors(token_hash TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_catalog(workspace_id TEXT PRIMARY KEY,seed TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shares(token_hash TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,resource_id TEXT NOT NULL,kind TEXT NOT NULL,access TEXT NOT NULL,product_ids TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS uploads(filename TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS renders(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,prompt TEXT NOT NULL,url TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets(name TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS billing_events(id TEXT PRIMARY KEY,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS billing_subscriptions(workspace_id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,plan TEXT NOT NULL,interval TEXT NOT NULL DEFAULT 'monthly',status TEXT NOT NULL,period_start INTEGER NOT NULL,period_end INTEGER NOT NULL,paid_through INTEGER NOT NULL,credit_anchor INTEGER NOT NULL,last_credit_cycle TEXT NOT NULL,last_event_created INTEGER NOT NULL,cancel_at_period_end INTEGER NOT NULL DEFAULT 0);
    `);
    if(!(db.pragma('table_info(shares)') as {name:string}[]).some(column=>column.name==='product_ids'))db.exec("ALTER TABLE shares ADD COLUMN product_ids TEXT NOT NULL DEFAULT '[]'");
    if(!(db.pragma('table_info(billing_subscriptions)') as {name:string}[]).some(column=>column.name==='interval'))db.exec("ALTER TABLE billing_subscriptions ADD COLUMN interval TEXT NOT NULL DEFAULT 'monthly'");
  }
  day(){return new Intl.DateTimeFormat('en-CA',{timeZone:this.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(this.now());}
  get(id:string):WorkspaceRecord{
    return this.db.transaction(()=>this.read(id))();
  }
  private read(id:string):WorkspaceRecord{
    if(this.catalogPath){
      try{
        const stat=statSync(this.catalogPath),version=`${stat.mtimeMs}:${stat.size}`;
        if(version!==this.catalogFileVersion){const products:unknown=JSON.parse(readFileSync(this.catalogPath,'utf8'));validateState(makeState(products as Product[]));this.products=products as Product[];this.catalogFileVersion=version;}
      }catch{/* Keep the last valid catalog while a file is absent or being replaced. */}
    }
    const seed=this.products.filter(product=>!product.custom),seedJson=JSON.stringify(seed);
    let row=this.db.prepare('SELECT state,credit_day FROM workspaces WHERE id=?').get(id) as {state:string;credit_day:string}|undefined;
    if(!row){
      const state=makeState(structuredClone(this.products));
      state.credits.history.push({id:randomUUID(),activity:'Daily credits',amount:20,type:'daily',date:this.now().toISOString()});
      this.db.prepare('INSERT INTO workspaces(id,state,credit_day) VALUES(?,?,?)').run(id,JSON.stringify(state),this.day());
      this.db.prepare('INSERT OR REPLACE INTO workspace_catalog(workspace_id,seed) VALUES(?,?)').run(id,seedJson);
      row={state:JSON.stringify(state),credit_day:this.day()};
    }
    const state=JSON.parse(row.state) as WorkspaceState;
    let changed=false;
    const baseline=this.db.prepare('SELECT seed FROM workspace_catalog WHERE workspace_id=?').get(id) as {seed:string}|undefined;
    if(baseline?.seed!==seedJson){
      const previous=new Map((baseline?JSON.parse(baseline.seed) as Product[]:[]).map(product=>[product.id,product]));
      for(const product of seed){
        const index=state.products.findIndex(item=>item.id===product.id),current=state.products[index];
        if(current?.custom)continue;
        if(!current){if(baseline&&!previous.has(product.id)){state.products.push(structuredClone(product));changed=true;}continue;}
        const merged=mergeSeed(current,previous.get(product.id),product,!baseline) as Product;
        // These are workspace-owned flags rather than catalog facts.
        for(const key of ['custom','favorite'] as const){if(current[key]===undefined)delete merged[key];else merged[key]=current[key];}
        if(!same(current,merged)){state.products[index]=merged;changed=true;}
      }
      this.db.prepare('INSERT OR REPLACE INTO workspace_catalog(workspace_id,seed) VALUES(?,?)').run(id,seedJson);
    }
    if(row.credit_day!==this.day()){
      const amount=20-state.credits.daily;
      state.credits.daily=20;
      state.credits.history.unshift({id:randomUUID(),activity:'Daily credits refreshed',amount,type:'daily',date:this.now().toISOString()});
      changed=true;
    }
    const billing=this.db.prepare('SELECT * FROM billing_subscriptions WHERE workspace_id=?').get(id) as BillingRow|undefined;
    if(billing&&refreshBillingCredits(billing,state,this.now())){changed=true;this.db.prepare('UPDATE billing_subscriptions SET last_credit_cycle=? WHERE workspace_id=?').run(billing.last_credit_cycle,id);}
    if(changed){state.revision+=1;this.db.prepare('UPDATE workspaces SET state=?,credit_day=? WHERE id=?').run(JSON.stringify(state),this.day(),id);}
    return{id,state,creditDay:this.day()};
  }
  save(id:string,state:WorkspaceState){
    this.db.prepare('UPDATE workspaces SET state=?,credit_day=? WHERE id=?').run(JSON.stringify(state),this.day(),id);
  }
  mutate<T>(id:string,fn:(state:WorkspaceState)=>T):{state:WorkspaceState;result:T}{
    return this.db.transaction(()=>{
      const {state}=this.get(id);
      const catalogIds=new Set(this.products.map(product=>product.id)),customIds=new Set(state.products.filter(product=>product.custom).map(product=>product.id));
      const normalizeProducts=()=>{for(const product of state.products)if(!catalogIds.has(product.id)||customIds.has(product.id))product.custom=true;};
      // Product ownership is derived from the server catalog. A caller cannot turn
      // an uploaded/imported product into a free catalog asset by clearing its flag.
      normalizeProducts();
      const previous=workspaceUsage(state),limits=planLimits(state.plan,state.profile.verified);
      const result=fn(state);
      normalizeProducts();
      const next=workspaceUsage(state);
      for(const key of ['projects','libraries','savedAssets'] as const){const limit=limits[key];if(limit!==null&&next[key]>Math.max(limit,previous[key]))throw new HttpError(402,`Your plan allows ${limit} ${key==='savedAssets'?'saved products and images':key}. Existing work is kept; reduce usage or upgrade before adding more.`);}
      state.revision+=1;
      this.save(id,state);
      return{state,result};
    })();
  }
}

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const string=(value:unknown,max=10000):value is string=>typeof value==='string'&&value.length<=max;
const array=(value:unknown,max=5000):value is unknown[]=>Array.isArray(value)&&value.length<=max;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const id=(value:unknown)=>string(value,200)&&value.length>0;
const vec=(value:unknown):value is [number,number,number]=>array(value,3)&&value.length===3&&value.every(finite);
const shapes=['box','sphere','cylinder','plane','triangle','hexagon','blob','chair','table','plant'];
const safeKeys=(input:unknown,depth=0):boolean=>depth<=64&&(Array.isArray(input)?input.every(value=>safeKeys(value,depth+1)):!object(input)||Object.entries(input).every(([key,item])=>!['__proto__','constructor','prototype'].includes(key)&&safeKeys(item,depth+1)));
function webUrl(value:unknown){if(!string(value,10000))return false;if(!value)return true;try{const url=new URL(value);return['https:','http:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}}
function asset(value:unknown){return string(value,2_000_000)&&(!value||webUrl(value)||/^\/(uploads|assets)\/[a-zA-Z0-9._-]+$/.test(value)||/^\/api\/showrooms\/[a-z0-9][a-z0-9-]{2,62}\/assets\/[a-zA-Z0-9._-]+$/.test(value)||/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value));}
function specs(value:unknown){return object(value)&&Object.keys(value).length<=500&&Object.values(value).every(v=>string(v,10000));}
const materialNumbers=['roughness','metalness','ior','opacity','transmission','thickness','distance','bumpScale','textureWidth','textureHeight','textureRotation'];
const optionalMaterialNumbers=['normalScale','sheen','sheenRoughness','clearcoat','clearcoatRoughness','specularIntensity','aoMapIntensity'];
const materialMaps=['texture','roughnessMap','opacityMap','bumpMap','normalMap','ormMap','transmissionMap','thicknessMap'];
const materialColors=['attenuationColor','sheenColor','color'];
function mapTransforms(value:unknown){return object(value)&&Object.keys(value).every(key=>['diffuse','normal','orm','transmissionThickness'].includes(key))&&Object.values(value).every(transform=>object(transform)&&finite(transform.x)&&transform.x>0&&finite(transform.y)&&transform.y>0&&finite(transform.rotation));}
function material(value:unknown){return object(value)&&materialNumbers.every(k=>finite(value[k]))&&typeof value.normal==='boolean'&&string(value.attenuationColor,100)&&materialMaps.every(k=>value[k]===undefined||asset(value[k]))&&optionalMaterialNumbers.every(k=>value[k]===undefined||finite(value[k]))&&['sheenColor','color'].every(k=>value[k]===undefined||string(value[k],100))&&(value.mapTransforms===undefined||mapTransforms(value.mapTransforms));}
function partialMaterial(value:unknown){return object(value)&&Object.keys(value).every(key=>[...materialNumbers,...optionalMaterialNumbers,...materialMaps,...materialColors,'normal','mapTransforms'].includes(key))&&material({...defaultMaterial(),...value});}
function canvas(value:unknown){return object(value)&&['product','image','text','arrow','sketch','comment'].includes(String(value.type))&&['x','y','width','height','rotation'].every(k=>finite(value[k]))&&(value.points===undefined||(array(value.points,20000)&&value.points.every(point=>array(point,2)&&point.length===2&&point.every(finite))));}
function values(value:unknown){return object(value)&&Object.keys(value).length<=200&&Object.values(value).every(v=>string(v,20000)||finite(v));}
function column(c:unknown){return object(c)&&id(c.id)&&string(c.label,200)&&['text','image','details','supplier','status','number','select','attribute','badge'].includes(String(c.type))&&(!c.options||(array(c.options,200)&&c.options.every(v=>string(v,1000))));}
export function validBoard(value:unknown):boolean{
  if(!safeKeys(value)||!object(value)||!id(value.id)||!string(value.name,300)||!array(value.items,1000)||!object(value.settings))return false;
  const s=value.settings;
  if(!string(s.background,100)||!finite(s.lightIntensity)||!finite(s.temperature)||typeof s.grid!=='boolean'||typeof s.interactive!=='boolean'||!['top','perspective'].includes(String(s.view))||(s.backgroundImage!==undefined&&!asset(s.backgroundImage))||(s.mode!==undefined&&!['canvas','3d'].includes(String(s.mode))))return false;
  return value.items.every(i=>object(i)&&id(i.id)&&string(i.name,300)&&['material','furniture','prop','text','image'].includes(String(i.kind))&&shapes.includes(String(i.shape))&&string(i.color,100)&&vec(i.position)&&vec(i.rotation)&&vec(i.scale)&&typeof i.locked==='boolean'&&typeof i.visible==='boolean'&&(i.image===undefined||asset(i.image))&&(i.text===undefined||string(i.text,20000))&&material(i.material)&&(i.materialOverrides===undefined||partialMaterial(i.materialOverrides))&&(i.colorOverride===undefined||typeof i.colorOverride==='boolean')&&(i.canvas===undefined||canvas(i.canvas))&&(i.brand===undefined||string(i.brand,300))&&(i.notes===undefined||string(i.notes,20000))&&(i.specs===undefined||specs(i.specs))&&(i.productId===undefined||id(i.productId)));
}
export function validSchedule(value:unknown):boolean{
  return safeKeys(value)&&object(value)&&id(value.id)&&string(value.name,300)&&array(value.columns,100)&&value.columns.every(column)&&array(value.rows,5000)&&value.rows.every(r=>object(r)&&id(r.id)&&id(r.groupId)&&string(r.status,100)&&values(r.values))&&array(value.groups,200)&&value.groups.every(g=>object(g)&&id(g.id)&&string(g.name,300))&&(value.logo===undefined||asset(value.logo));
}
export function validateState(value:unknown):asserts value is WorkspaceState{
  if(!safeKeys(value))throw new HttpError(400,'Unsafe object keys are not allowed.');
  if(!object(value)||!array(value.products,20000)||!array(value.projects,1000)||!array(value.libraries,1000)||!array(value.favorites,20000)||!object(value.profile)||!object(value.settings)||!array(value.presets,300))throw new HttpError(400,'Invalid workspace structure.');
  if(!Number.isInteger(value.revision)||Number(value.revision)<0||!['Free','Starter','Plus','Studio'].includes(String(value.plan))||!object(value.credits)||!['daily','monthly','bonus'].every(k=>finite(value.credits&&object(value.credits)?value.credits[k]:null)&&Number(object(value.credits)?value.credits[k]:-1)>=0)||!array(value.credits.history,100000)||!value.credits.history.every(h=>object(h)&&id(h.id)&&string(h.activity,500)&&finite(h.amount)&&['daily','monthly','bonus'].includes(String(h.type))&&string(h.date,100)))throw new HttpError(400,'Invalid credit or plan data.');
  if(!array(value.inbox,100000)||!value.inbox.every(i=>object(i)&&id(i.id)&&string(i.title,500)&&string(i.message,30000)&&string(i.date,100)&&typeof i.read==='boolean'&&string(i.type,100))||!array(value.requests,100000)||!value.requests.every(r=>object(r)&&id(r.id)&&array(r.productIds,100)&&r.productIds.every(id)&&['quote','sample'].includes(String(r.type))&&['draft','submitted','sent','failed','replied'].includes(String(r.status))&&string(r.name,300)&&string(r.email,320)&&string(r.message,20000)&&string(r.date,100)))throw new HttpError(400,'Invalid request or inbox data.');
  if(!value.products.every(p=>object(p)&&id(p.id)&&string(p.name,500)&&string(p.brand,300)&&string(p.category,300)&&string(p.type,300)&&asset(p.image)&&string(p.color,100)&&finite(p.price)&&string(p.description,100000)&&specs(p.specs)&&array(p.variants,1000)&&p.variants.every(v=>object(v)&&string(v.name,500)&&string(v.color,100)&&(v.image===undefined||asset(v.image))&&(v.productId===undefined||id(v.productId)))&&(p.texture===undefined||asset(p.texture))&&(p.model===undefined||asset(p.model))&&(p.images===undefined||(array(p.images,1000)&&p.images.every(asset)))&&(p.variantIds===undefined||(array(p.variantIds,1000)&&p.variantIds.every(id)))&&(p.modelSize===undefined||(vec(p.modelSize)&&p.modelSize.every(size=>finite(size)&&size>=0)))&&(p.sampleKind===undefined||['model','alpha-plane','box'].includes(String(p.sampleKind)))&&(p.material===undefined||material(p.material))&&(p.shape===undefined||shapes.includes(String(p.shape)))&&(p.sourceUrl===undefined||webUrl(p.sourceUrl))&&(p.files===undefined||(array(p.files,1000)&&p.files.every(f=>object(f)&&string(f.name,500)&&asset(f.url))))))throw new HttpError(400,'Invalid product data.');
  if(!value.projects.every(p=>object(p)&&id(p.id)&&string(p.name,500)&&string(p.description,10000)&&asset(p.cover)&&array(p.boards,1000)&&p.boards.every(validBoard)&&array(p.schedules,1000)&&p.schedules.every(validSchedule)&&array(p.drawer,20000)&&p.drawer.every(id)&&array(p.members,1000)&&p.members.every(m=>object(m)&&string(m.email,320)&&['owner','editor','viewer'].includes(String(m.role)))))throw new HttpError(400,'Invalid project data.');
  if(!value.libraries.every(l=>object(l)&&id(l.id)&&string(l.name,500)&&array(l.productIds,20000)&&l.productIds.every(id)&&typeof l.shared==='boolean'&&array(l.members,1000)&&l.members.every(v=>string(v,320))&&(l.shareToken===undefined||string(l.shareToken,200)))||!value.favorites.every(id))throw new HttpError(400,'Invalid library data.');
  const p=value.profile;
  if(!['name','email','username','country','bio'].every(k=>string(p[k],10000))||!asset(p.avatar)||typeof p.public!=='boolean'||typeof p.verified!=='boolean')throw new HttpError(400,'Invalid profile data.');
  if(!Object.values(value.settings).every(v=>typeof v==='boolean'||string(v,10000))||!value.presets.every(p=>object(p)&&id(p.id)&&string(p.name,500)&&array(p.columns,100)&&p.columns.every(column)))throw new HttpError(400,'Invalid settings or presets.');
  for(const entries of [value.products,value.projects,value.libraries]){
    const ids=entries.map(v=>object(v)?v.id:null);if(new Set(ids).size!==ids.length)throw new HttpError(400,'Duplicate identifiers are not allowed.');
  }
}
