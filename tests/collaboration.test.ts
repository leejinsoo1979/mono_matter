import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Server} from 'node:http';
import {Store,HttpError} from '../server/store.ts';
import {registerCollaborationRoutes} from '../server/collaboration.ts';
import {makeBoard,makeSchedule,defaultMaterial} from '../shared/defaults.ts';
import type {Product} from '../shared/types.ts';

const publicProduct:Product={id:'public',name:'Oak',brand:'Studio',category:'Wood',type:'Material',image:'/assets/oak.webp',color:'#aa9988',price:10,description:'Oak finish',specs:{Width:'100 mm'},variants:[]};
const sharedProduct:Product={...publicProduct,id:'shared',name:'Shared private sample',custom:true};
const secretProduct:Product={...publicProduct,id:'secret',name:'Unrelated private sample',custom:true};
async function fixture(t:TestContext){
  const directory=mkdtempSync(path.join(tmpdir(),'monogram-collaboration-'));
  const db=new Database(path.join(directory,'test.sqlite')),now=()=>new Date('2026-10-16T00:00:00Z');
  const store=new Store(db,[publicProduct],now);
  for(const id of ['owner','viewer','stranger']){const {state}=store.get(id);state.plan='Plus';state.products=[publicProduct,sharedProduct,secretProduct];state.projects=[];state.libraries=[];store.save(id,state);}
  const owner=store.get('owner').state,board=makeBoard('Owner board'),schedule=makeSchedule('Owner schedule');board.shareToken='private-board-token';schedule.shareToken='private-schedule-token';
  board.items=[{id:'item',productId:'shared',name:'Sample',kind:'material',shape:'box',color:'#fff',position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],locked:false,visible:true,material:defaultMaterial()}];
  owner.projects=[{id:'project',name:'Shared residence',description:'Project description',cover:'',boards:[board],schedules:[schedule],drawer:['public'],members:[{email:'private@example.test',role:'owner'}],updatedAt:now().toISOString()}];
  owner.libraries=[{id:'library',name:'Shared finishes',productIds:['shared'],shared:false,members:['private@example.test'],shareToken:'private-library-token'}];store.save('owner',owner);
  const app=express();app.use(express.json());registerCollaborationRoutes(app,{store,now,appUrl:'http://127.0.0.1:5173',broadcast:()=>{},requireContext:(req,res,next)=>{const id=req.headers['x-test-workspace'];if(typeof id!=='string')return res.status(401).json({error:'Sign in'});res.locals.context={workspaceId:id,user:{email:`${id}@example.test`,visitor:false}};next();},getContext:res=>res.locals.context});
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error instanceof HttpError?error.status:500).json({error:error instanceof Error?error.message:'Unexpected error'}));
  const server:Server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();assert.ok(address&&typeof address==='object');
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();rmSync(directory,{recursive:true,force:true});});
  const request=async(route:string,{workspace,method='GET',body}:{workspace?:string;method?:string;body?:unknown}={})=>{const result=await fetch(`http://127.0.0.1:${address.port}${route}`,{method,headers:{...(workspace?{'x-test-workspace':workspace}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:result.status,data:await result.json()};};
  const create=async(kind:'projects'|'libraries',access:'view'|'edit')=>{const result=await request(`/api/collaboration/${kind}/${kind==='projects'?'project':'library'}/links`,{workspace:'owner',method:'POST',body:{access,label:'Partner'}});assert.equal(result.status,201);return result.data;};
  return {store,db,request,create};
}

test('project viewer snapshots omit private tokens, member emails, and unrelated products; writes are denied',async t=>{
  const f=await fixture(t),link=await f.create('projects','view');
  const view=await f.request(`/api/collaboration/share/${link.token}`);assert.equal(view.status,200);assert.deepEqual(view.data.project.members,[]);assert.deepEqual(view.data.products.map((product:Product)=>product.id),['public','shared']);assert.equal(view.data.watermark,false);
  assert.ok(!JSON.stringify(view.data).includes('private-board-token'));assert.ok(!JSON.stringify(view.data).includes('private-schedule-token'));assert.ok(!JSON.stringify(view.data).includes('private@example.test'));assert.ok(!JSON.stringify(view.data).includes('Unrelated private sample'));
  assert.equal((await f.request(`/api/collaboration/share/${link.token}`,{method:'PUT',body:{baseRevision:view.data.revision,project:view.data.project}})).status,403);
  const saved=f.db.prepare('SELECT * FROM collaboration_links').get() as Record<string,unknown>;assert.notEqual(saved.token_hash,link.token);assert.ok(!Object.values(saved).includes(link.token));
});

test('project editor saves scoped resources, protects owner fields and tokens, and detects stale writes',async t=>{
  const f=await fixture(t),link=await f.create('projects','edit'),route=`/api/collaboration/share/${link.token}`;
  const view=(await f.request(route)).data;view.project.boards[0].name='Revised board';view.project.members=[{email:'attacker@example.test',role:'owner'}];view.project.archived=true;
  const saved=await f.request(route,{method:'PUT',body:{baseRevision:view.revision,project:view.project}});assert.equal(saved.status,200);assert.equal(saved.data.project.boards[0].name,'Revised board');
  const owner=f.store.get('owner').state;assert.equal(owner.projects[0].boards[0].shareToken,'private-board-token');assert.equal(owner.projects[0].schedules[0].shareToken,'private-schedule-token');assert.equal(owner.projects[0].members[0].email,'private@example.test');assert.equal(owner.projects[0].archived,undefined);
  assert.equal((await f.request(route,{method:'PUT',body:{baseRevision:view.revision,project:view.project}})).status,409);
  const forged=structuredClone(saved.data.project);forged.boards[0].items[0].productId='secret';assert.equal((await f.request(route,{method:'PUT',body:{baseRevision:saved.data.revision,project:forged}})).status,403);
});

test('only an owner lists and revokes links; revocation immediately denies bearer access',async t=>{
  const f=await fixture(t),link=await f.create('projects','edit');
  assert.equal((await f.request('/api/collaboration/projects/project/links')).status,401);
  assert.equal((await f.request('/api/collaboration/projects/project/links',{workspace:'stranger'})).status,404);
  const owner=(await f.request('/api/collaboration/projects/project/links',{workspace:'owner'})).data;assert.equal(owner.links.length,1);assert.equal(owner.links[0].label,'Partner');assert.ok(!('token' in owner.links[0]));
  assert.equal((await f.request(`/api/collaboration/links/${link.link.id}`,{workspace:'stranger',method:'DELETE'})).status,403);
  assert.equal((await f.request(`/api/collaboration/links/${link.link.id}`,{workspace:'owner',method:'DELETE'})).status,200);
  assert.equal((await f.request(`/api/collaboration/share/${link.token}`)).status,404);
});

test('library sharing follows paid entitlements and keeps the product allowlist fixed',async t=>{
  const f=await fixture(t);const state=f.store.get('owner').state;state.plan='Starter';f.store.save('owner',state);
  assert.equal((await f.request('/api/collaboration/libraries/library/links',{workspace:'owner',method:'POST',body:{access:'view'}})).status,402);
  state.plan='Plus';f.store.save('owner',state);const link=await f.create('libraries','edit'),route=`/api/collaboration/share/${link.token}`;
  const view=(await f.request(route)).data;assert.deepEqual(view.library.members,[]);assert.ok(!JSON.stringify(view).includes('private-library-token'));assert.deepEqual(view.products.map((product:Product)=>product.id),['shared']);
  f.store.mutate('owner',draft=>{draft.libraries[0].productIds.push('secret');});const after=(await f.request(route)).data;assert.deepEqual(after.library.productIds,['shared']);assert.deepEqual(after.products.map((product:Product)=>product.id),['shared']);
  const product={...after.products[0],description:'Edited finish'};const saved=await f.request(route,{method:'PUT',body:{baseRevision:after.revision,library:after.library,products:[product]}});assert.equal(saved.status,200);assert.equal(f.store.get('owner').state.products.find(item=>item.id==='shared')?.description,'Edited finish');
  assert.equal((await f.request(route,{method:'PUT',body:{baseRevision:saved.data.revision,library:saved.data.library,products:[{...product,id:'secret'}]}})).status,403);
  assert.equal((await f.request(route,{method:'PUT',body:{baseRevision:saved.data.revision,library:{...saved.data.library,productIds:['secret']}}})).status,403);
});

test('explicit library copy creates independent product IDs and preserves owner edits and secrets',async t=>{
  const f=await fixture(t),link=await f.create('libraries','view');
  assert.equal((await f.request(`/api/collaboration/share/${link.token}/copy`,{method:'POST'})).status,401);
  const before=f.store.get('viewer').state.products.length;
  const result=await f.request(`/api/collaboration/share/${link.token}/copy`,{workspace:'viewer',method:'POST'});assert.equal(result.status,201);
  const library=result.data.state.libraries.find((item:{id:string})=>item.id===result.data.libraryId);assert.equal(library.shared,false);assert.deepEqual(library.members,[]);assert.equal(library.productIds.length,1);assert.notEqual(library.productIds[0],'shared');assert.equal(result.data.state.products.length,before+1);
  f.store.mutate('viewer',state=>{state.products.find(item=>item.id===library.productIds[0])!.name='Independent copy';});assert.equal(f.store.get('owner').state.products.find(item=>item.id==='shared')?.name,'Shared private sample');
});

test('archived or deleted resources stop collaboration access and owner plan controls export branding',async t=>{
  const f=await fixture(t),link=await f.create('projects','view');f.store.mutate('owner',state=>{state.plan='Free';});assert.equal((await f.request(`/api/collaboration/share/${link.token}`)).data.watermark,true);
  f.store.mutate('owner',state=>{state.projects[0].archived=true;});assert.equal((await f.request(`/api/collaboration/share/${link.token}`)).status,404);
  assert.equal((await f.request('/api/collaboration/share/not-a-token')).status,404);
});


test('shared edits preserve products, rows, and drawers added privately after link creation',async t=>{
  const f=await fixture(t),link=await f.create('projects','edit'),route=`/api/collaboration/share/${link.token}`;
  f.store.mutate('owner',state=>{const project=state.projects[0];project.boards[0].items.push({...structuredClone(project.boards[0].items[0]),id:'hidden-item',productId:'secret'});project.schedules[0].groups.push({id:'private-group',name:'Private group'});project.schedules[0].rows.push({id:'hidden-row',productId:'secret',groupId:'private-group',values:{remarks:'Private notes'},status:'Draft'});project.drawer.push('secret');});
  const view=(await f.request(route)).data;assert.equal(view.project.boards[0].items.length,1);assert.equal(view.project.schedules[0].rows.length,0);assert.ok(!view.project.drawer.includes('secret'));
  view.project.boards[0].name='Safe public rename';view.project.schedules[0].groups=[];
  const saved=await f.request(route,{method:'PUT',body:{baseRevision:view.revision,project:view.project}});assert.equal(saved.status,200);
  const project=f.store.get('owner').state.projects[0];assert.equal(project.boards[0].name,'Safe public rename');assert.ok(project.boards[0].items.some(item=>item.id==='hidden-item'&&item.productId==='secret'));assert.ok(project.schedules[0].rows.some(row=>row.id==='hidden-row'));assert.ok(project.schedules[0].groups.some(group=>group.id==='private-group'));assert.ok(project.drawer.includes('secret'));
  const forged=structuredClone(saved.data.project);forged.boards=[];assert.equal((await f.request(route,{method:'PUT',body:{baseRevision:saved.data.revision,project:forged}})).status,403);
});

test('shared library membership edits preserve newer private additions and let editors restore scoped materials',async t=>{
  const f=await fixture(t),link=await f.create('libraries','edit'),route=`/api/collaboration/share/${link.token}`;
  f.store.mutate('owner',state=>state.libraries[0].productIds.push('secret'));let view=(await f.request(route)).data;view.library.productIds=[];
  const saved=await f.request(route,{method:'PUT',body:{baseRevision:view.revision,library:view.library,products:view.products}});assert.equal(saved.status,200);assert.deepEqual(f.store.get('owner').state.libraries[0].productIds,['secret']);assert.deepEqual(saved.data.library.productIds,[]);assert.deepEqual(saved.data.products.map((item:Product)=>item.id),['shared']);
  view=saved.data;view.library.productIds=['shared'];assert.equal((await f.request(route,{method:'PUT',body:{baseRevision:view.revision,library:view.library,products:view.products}})).status,200);assert.deepEqual(f.store.get('owner').state.libraries[0].productIds,['shared','secret']);
});
