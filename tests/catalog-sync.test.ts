import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import type {Product,WorkspaceState} from '../shared/types.ts';
import {createApp} from '../server/app.ts';
import {defaultMaterial} from '../shared/defaults.ts';

const catalog=JSON.parse(readFileSync(new URL('../data/catalog.json',import.meta.url),'utf8')) as Product[];
async function fixture(t:TestContext){
  const directory=mkdtempSync(path.join(tmpdir(),'monogram-catalog-recovery-'));const runtime=await createApp({dataDir:directory,catalog,now:()=>new Date('2026-10-17T00:00:00Z'),env:{APP_URL:'http://127.0.0.1:5173',BETTER_AUTH_URL:'http://127.0.0.1:5173'}});
  const server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async()=>{runtime.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});});
  const boot=await fetch(`${base}/api/bootstrap`),cookie=boot.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '),payload=await boot.json();
  const call=async(route:string,{anonymous=false,method='GET',body}:{anonymous?:boolean;method?:string;body?:unknown}={})=>{const response=await fetch(`${base}${route}`,{method,headers:{...(!anonymous?{cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return{status:response.status,data:await response.json()};};
  return{runtime,call,workspaceId:payload.workspaceId as string,state:payload.state as WorkspaceState};
}

for(const baseline of ['missing','already-expanded'] as const)test(`explicit catalog restore repairs a legacy 47-product workspace with ${baseline} baseline without replacing private work`,async t=>{
  assert.equal(catalog.length,445);const f=await fixture(t),variantProduct=catalog.find(product=>product.variants.length>0)!;assert.ok(variantProduct);
  const chosen=[...catalog.filter(product=>product.id!==variantProduct.id).slice(0,46),variantProduct];const state=f.state;
  state.products=chosen.map(product=>({...structuredClone(product),description:'Legacy product details',variants:[],images:undefined,variantIds:undefined,model:undefined,modelSize:undefined,material:undefined}));
  state.products[0]={...state.products[0],custom:true,name:'Custom local asset',model:'/uploads/local-fixture.glb',specs:{Private:'Custom specification'}};
  const variant=state.products.find(product=>product.id===variantProduct.id)!;variant.favorite=true;Object.assign(variant,{privateAnnotation:'Keep this local annotation'});
  state.favorites=[variantProduct.id];state.libraries[0].productIds=[variantProduct.id];state.profile.bio='Private profile draft';state.settings.privatePreference='Keep this setting';state.projects[0].name='Private active project';state.projects[0].drawer=[variantProduct.id];state.projects[0].boards[0].items=[{id:'local-board-item',productId:variantProduct.id,name:'Locally edited finish',kind:'material',shape:'box',color:'#123456',position:[1,2,3],rotation:[0,0,0],scale:[2,3,4],locked:false,visible:true,material:{...defaultMaterial(),roughness:0.92}}];
  f.runtime.store.save(f.workspaceId,state);if(baseline==='missing')f.runtime.db.prepare('DELETE FROM workspace_catalog WHERE workspace_id=?').run(f.workspaceId);
  // This reproduces the live hole: the conservative read cannot distinguish missing source records from deletions.
  const legacy=await f.call('/api/workspace');assert.equal(legacy.data.state.products.length,47);const before=structuredClone(legacy.data.state) as WorkspaceState;
  const body={mode:'restore-public-catalog'};assert.equal((await f.call('/api/catalog/sync',{anonymous:true,method:'POST',body})).status,401);assert.equal((await f.call('/api/catalog/sync',{method:'POST',body:{mode:'unknown'}})).status,400);
  const restored=await f.call('/api/catalog/sync',{method:'POST',body});assert.equal(restored.status,200);assert.equal(restored.data.added,398);assert.equal(restored.data.catalogCount,445);assert.equal(restored.data.preservedCustom,1);assert.ok(restored.data.refreshed>0);const after=restored.data.state as WorkspaceState;assert.equal(after.products.length,445);assert.equal(after.revision,before.revision+1);
  assert.deepEqual(after.products.find(product=>product.id===chosen[0].id),before.products[0]);const refreshed=after.products.find(product=>product.id===variantProduct.id)!;assert.deepEqual(refreshed.variants,variantProduct.variants);assert.deepEqual(refreshed.material,variantProduct.material);assert.deepEqual(refreshed.images,variantProduct.images);assert.equal(refreshed.favorite,true);assert.equal((refreshed as unknown as Record<string,unknown>).privateAnnotation,'Keep this local annotation');
  for(const field of ['projects','libraries','favorites','profile','settings','credits','requests','inbox','presets'] as const)assert.deepEqual(after[field],before[field],`${field} must remain unchanged`);
  const again=await f.call('/api/catalog/sync',{method:'POST',body});assert.equal(again.status,200);assert.equal(again.data.added,0);assert.equal(again.data.refreshed,0);assert.deepEqual(again.data.state.projects,before.projects);
});
