import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import express,{type Request,type Response,type NextFunction} from 'express';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import {Store,HttpError} from '../server/store.ts';
import {registerSupplierRoutes,SupplierRepository} from '../server/supplier.ts';
import {makeSupplierProfile} from '../shared/supplier.ts';
import type {SupplierEditableState,SupplierProduct,SupplierState} from '../shared/supplier.ts';
import {defaultMaterial} from '../shared/defaults.ts';

const product=(id='published',published=true):SupplierProduct=>({id,name:`Material ${id}`,brand:'Sample Studio',category:'Tile',type:'Material',image:'/assets/sample.webp',color:'#b3a28f',price:20,description:'Public product story',specs:{Width:'200 mm'},variants:[{name:'Natural',color:'#b3a28f'}],published,privateNotes:'private supplier price',createdAt:'',updatedAt:''});
const catalog=(slug='sample-studio'):SupplierEditableState=>({profile:{...makeSupplierProfile('Sample Studio'),slug,published:true,contactEmail:'private-owner@example.test',contactName:'Private contact',phone:'private-phone',internalNotes:'private business notes',description:'A public brand story'},products:[product(),product('draft',false)],collections:[{id:'collection',name:'Natural finishes',description:'Public collection',cover:'',productIds:['published','draft'],published:true}],gallery:[{id:'gallery',title:'Public project',description:'A project story',image:'/assets/project.webp',productIds:['published','draft'],published:true}]});
const requestInput={type:'sample',name:'Test designer',email:'designer@example.test',company:'Test architecture',phone:'',message:'Please provide a physical sample.',productIds:['published']};
async function fixture(t:TestContext){
 const dir=mkdtempSync(path.join(tmpdir(),'monogram-supplier-')),uploadDir=path.join(dir,'uploads');mkdirSync(uploadDir);
 const db=new Database(path.join(dir,'supplier.sqlite')),store=new Store(db,[],()=>new Date('2026-10-17T01:00:00Z'));
 const app=express();app.use(express.json({limit:'12mb'}));const events:{workspaceId:string;revision:number}[]=[];
 const repository=registerSupplierRoutes(app,{store,uploadDir,requireContext:(req,res,next)=>{const workspaceId=req.headers['x-workspace'];if(typeof workspaceId!=='string')return next(new HttpError(401,'Sign in.'));res.locals.context={workspaceId,user:{id:workspaceId,name:workspaceId,email:`${workspaceId}@example.test`,visitor:false}};next();},getContext:res=>res.locals.context,broadcast:(workspaceId,state)=>events.push({workspaceId,revision:state.revision})});
 app.use((error:Error&{status?:number},_req:Request,res:Response,_next:NextFunction)=>{res.status(error.status||500).json({error:error.message});});
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();rmSync(dir,{recursive:true,force:true});});
 const call=async(route:string,{workspace='owner',method='GET',body}:{workspace?:string|null;method?:string;body?:unknown}={})=>{const response=await fetch(`${base}${route}`,{method,headers:{...(workspace?{'x-workspace':workspace}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const data=response.headers.get('content-type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer());return{status:response.status,data};};
 const save=async(state=catalog(),revision=0,workspace='owner')=>call('/api/supplier',{workspace,method:'PUT',body:{state,baseRevision:revision,workspaceId:workspace}});
 return{db,store,repository,call,save,events,dir,uploadDir};
}

test('supplier owner workspace and published showroom persist in separate SQLite tables',async t=>{
 const f=await fixture(t);assert.equal((await f.call('/api/supplier',{workspace:null})).status,401);
 const initial=await f.call('/api/supplier');assert.equal(initial.data.state.revision,0);assert.equal(initial.data.state.profile,null);
 const saved=await f.save();assert.equal(saved.status,200);assert.equal(saved.data.state.revision,1);assert.equal(saved.data.state.products.length,2);
 assert.equal((await f.call('/api/supplier',{workspace:'other'})).data.state.profile,null);
 const reopenedDb=new Database(path.join(f.dir,'supplier.sqlite'));try{const reopened=new SupplierRepository(new Store(reopenedDb,[],()=>new Date()));const state=reopened.get('owner');assert.equal(state.profile?.businessName,'Sample Studio');assert.equal(state.products[0].privateNotes,'private supplier price');assert.equal(state.collections.length,1);assert.equal(reopened.get('other').products.length,0);}finally{reopenedDb.close();}
 assert.equal((await f.call('/api/supplier',{method:'PUT',body:{state:catalog(),baseRevision:1,workspaceId:'other'}})).status,403);
});

test('supplier optimistic concurrency rejects stale saves and preserves catalog atomically',async t=>{
 const f=await fixture(t);await f.save();const changed=catalog();changed.products[0].name='New finish';assert.equal((await f.save(changed,1)).status,200);
 const stale=catalog();stale.profile!.businessName='Stale overwrite';assert.equal((await f.save(stale,1)).status,409);
 const latest=await f.call('/api/supplier');assert.equal(latest.data.state.products[0].name,'New finish');assert.equal(latest.data.state.profile.businessName,'Sample Studio');assert.equal(latest.data.state.revision,2);
 const duplicate=await f.save(catalog(),0,'other');assert.equal(duplicate.status,409);assert.equal((await f.call('/api/supplier',{workspace:'other'})).data.state.profile,null);
});

test('public showroom whitelist excludes private contacts, draft products, notes and unrecognised nested fields',async t=>{
 const f=await fixture(t);const input=catalog();(input.products[0].variants[0] as unknown as Record<string,unknown>).privateSupplierToken='private-variant';input.products[0].material={...defaultMaterial(),sheen:.8,sheenColor:'#ffffff',clearcoat:.4,specularIntensity:.7,aoMapIntensity:.5,color:'#aabbcc',mapTransforms:{normal:{x:2,y:3,rotation:1}},...{privateToken:'private-material'}};Object.assign(input.products[0].material.mapTransforms!.normal!,{privateToken:'private-transform'});Object.assign(input.collections[0],{privateContact:'private-collection'});Object.assign(input.gallery[0],{privateContact:'private-gallery'});
 assert.equal((await f.save(input)).status,200);const result=await f.call('/api/showrooms/sample-studio',{workspace:null});assert.equal(result.status,200);assert.equal(result.data.products.length,1);assert.deepEqual(result.data.collections[0].productIds,['published']);assert.deepEqual(result.data.gallery[0].productIds,['published']);assert.equal(result.data.products[0].material.sheen,.8);assert.equal(result.data.products[0].material.color,'#aabbcc');assert.deepEqual(result.data.products[0].material.mapTransforms,{normal:{x:2,y:3,rotation:1}});const serialized=JSON.stringify(result.data);
 for(const secret of ['private-owner','Private contact','private-phone','private business notes','private supplier price','private-variant','private-material','private-transform','private-collection','private-gallery','leads','workspace_id'])assert.ok(!serialized.includes(secret),`${secret} must remain private`);
 const unpublished=catalog();unpublished.profile!.published=false;assert.equal((await f.save(unpublished,1)).status,200);assert.equal((await f.call('/api/showrooms/sample-studio',{workspace:null})).status,404);
});

test('supplier validation rejects unsafe URLs, references, slugs and prototype keys without a partial write',async t=>{
 const f=await fixture(t);const invalid=catalog();invalid.products[0].image='javascript:alert(1)';assert.equal((await f.save(invalid)).status,400);
 const missing=catalog();missing.collections[0].productIds=['foreign-private'];assert.equal((await f.save(missing)).status,400);
 const badSlug=catalog();badSlug.profile!.slug='../../private';assert.equal((await f.save(badSlug)).status,400);
 const proto=JSON.parse(JSON.stringify(catalog()).replace('"specs":{"Width":"200 mm"}','"specs":{"__proto__":"unsafe"}'));assert.equal((await f.save(proto)).status,400);
 assert.equal((await f.call('/api/supplier')).data.state.revision,0);assert.equal((await f.save()).status,200);
});

test('published asset access requires both the exact published reference and owning upload workspace',async t=>{
 const f=await fixture(t);const input=catalog();input.products[0].image='/uploads/public.png';input.products[0].model='/uploads/public.glb';input.products[1].image='/uploads/draft.png';input.profile!.logo='/uploads/foreign.png';
 for(const [filename,owner] of [['public.png','owner'],['public.glb','owner'],['draft.png','owner'],['unlisted.png','owner'],['foreign.png','other']]){f.db.prepare('INSERT INTO uploads(filename,workspace_id,name,mime,size) VALUES(?,?,?,?,?)').run(filename,owner,filename,filename.endsWith('.glb')?'model/gltf-binary':'image/png',4);writeFileSync(path.join(f.uploadDir,filename),'test');}
 assert.equal((await f.save(input)).status,200);const publicData=await f.call('/api/showrooms/sample-studio',{workspace:null});assert.equal(publicData.data.products[0].image,'/api/showrooms/sample-studio/assets/public.png');assert.equal(publicData.data.products[0].model,'/api/showrooms/sample-studio/assets/public.glb');
 assert.equal((await f.call('/api/showrooms/sample-studio/assets/public.png',{workspace:null})).status,200);assert.equal((await f.call('/api/showrooms/sample-studio/assets/public.glb',{workspace:null})).status,200);
 for(const name of ['draft.png','unlisted.png','foreign.png'])assert.equal((await f.call(`/api/showrooms/sample-studio/assets/${name}`,{workspace:null})).status,404);
});

test('showroom requests become private supplier leads; replies reach only the requester inbox',async t=>{
 const f=await fixture(t);await f.save();assert.equal((await f.call('/api/showrooms/sample-studio/requests',{workspace:null,method:'POST',body:requestInput})).status,401);
 assert.equal((await f.call('/api/showrooms/sample-studio/requests',{workspace:'designer',method:'POST',body:{...requestInput,productIds:['draft']}})).status,400);
 const sent=await f.call('/api/showrooms/sample-studio/requests',{workspace:'designer',method:'POST',body:requestInput});assert.equal(sent.status,201);assert.equal(sent.data.delivery,'internal');assert.equal(sent.data.state.requests[0].status,'submitted');assert.equal(sent.data.state.products[0].id,'published');
 const owner=await f.call('/api/supplier'),lead=owner.data.state.leads[0];assert.equal(lead.email,'designer@example.test');assert.equal(lead.source,'showroom');assert.equal((await f.call('/api/supplier',{workspace:'other'})).data.state.leads.length,0);
 assert.equal((await f.call(`/api/supplier/leads/${lead.id}`,{workspace:'other',method:'PATCH',body:{baseRevision:0,patch:{status:'won'}}})).status,404);
 const changed=await f.call(`/api/supplier/leads/${lead.id}`,{method:'PATCH',body:{baseRevision:owner.data.state.revision,patch:{notes:'private negotiation note',status:'qualified',followUpAt:'2026-10-18T08:00:00Z'}}});assert.equal(changed.status,200);
 const reply=await f.call(`/api/supplier/leads/${lead.id}/replies`,{method:'POST',body:{baseRevision:changed.data.state.revision,message:'Your sample is available for collection.'}});assert.equal(reply.status,201);assert.equal(reply.data.delivery,'internal');assert.match(reply.data.message,/No email/);
 const requester=f.store.get('designer').state;assert.equal(requester.requests[0].status,'replied');assert.equal(requester.inbox[0].message,'Your sample is available for collection.');assert.equal(f.store.get('other').state.inbox.length,0);
 const thread=await f.call('/api/supplier/request-history',{workspace:'designer'});assert.equal(thread.data.requests[0].replies.length,1);assert.ok(!JSON.stringify(thread.data).includes('private negotiation note'));
 const publicData=await f.call('/api/showrooms/sample-studio',{workspace:null});assert.ok(!JSON.stringify(publicData.data).includes('designer@example.test'));assert.ok(!JSON.stringify(publicData.data).includes('private negotiation note'));
 assert.ok(f.events.some(e=>e.workspaceId==='owner'));assert.ok(f.events.some(e=>e.workspaceId==='designer'));
});

test('manual follow-ups remain recorded locally and require current lead revision',async t=>{
 const f=await fixture(t);await f.save();const added=await f.call('/api/supplier/leads',{method:'POST',body:{lead:requestInput,baseRevision:1}});assert.equal(added.status,201);const state=added.data.state as SupplierState,lead=state.leads[0];
 const reply=await f.call(`/api/supplier/leads/${lead.id}/replies`,{method:'POST',body:{baseRevision:state.revision,message:'Discussed finish options by phone.'}});assert.equal(reply.status,201);assert.equal(reply.data.delivery,'recorded');assert.match(reply.data.message,/No external/);assert.equal(f.store.get('owner').state.inbox.length,0);
 assert.equal((await f.call(`/api/supplier/leads/${lead.id}/replies`,{method:'POST',body:{baseRevision:state.revision,message:'Stale reply'}})).status,409);
 const latest=await f.call('/api/supplier');assert.equal(latest.data.state.leads[0].replies.length,1);
});
