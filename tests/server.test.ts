import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Server} from 'node:http';
import {request as httpRequest} from 'node:http';
import {randomBytes,createHmac} from 'node:crypto';
import {createApp,type AppOptions} from '../server/app.ts';
import {defaultMaterial} from '../shared/defaults.ts';
import type {Product,WorkspaceState} from '../shared/types.ts';
import {addCalendarMonths} from '../server/billing-state.ts';
import {loadEnvFiles} from '../server/env.ts';
import Database from 'better-sqlite3';
import {Store} from '../server/store.ts';

const product:Product={id:'public-product',name:'Material',brand:'Test brand',category:'Fabric',type:'Material',image:'/assets/sample.webp',color:'#aabbcc',price:0,description:'',specs:{},variants:[]};
const privateProduct:Product={...product,id:'private-product',name:'Private material',custom:true};
const origin='http://127.0.0.1:5173';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
async function fixture(t:TestContext,options:AppOptions={}){
  const dataDir=mkdtempSync(path.join(tmpdir(),'monogram-api-'));
  const env={APP_URL:origin,BETTER_AUTH_URL:origin,BETTER_AUTH_SECRET:randomBytes(48).toString('hex'),...options.env};
  let runtime=await createApp({...options,dataDir,env,catalog:[product,privateProduct]});
  let server:Server;let base='';
  async function listen(){server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();assert.ok(address&&typeof address==='object');base=`http://127.0.0.1:${address.port}`;}
  await listen();
  t.after(async()=>{runtime.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dataDir,{recursive:true,force:true});});
  const jar=new Map<string,string>();
  const cookies=()=>[...jar].map(([name,value])=>`${name}=${value}`).join('; ');
  async function request(route:string,init:RequestInit={}){
    const headers=new Headers(init.headers);if(!headers.has('cookie')&&jar.size)headers.set('cookie',cookies());
    if(init.body&&!(init.body instanceof FormData))headers.set('content-type','application/json');
    const response=await fetch(`${base}${route}`,{...init,headers});
    for(const cookie of response.headers.getSetCookie()){const [pair]=cookie.split(';');const index=pair.indexOf('=');const name=pair.slice(0,index);const value=pair.slice(index+1);if(!value||/Max-Age=0/i.test(cookie))jar.delete(name);else jar.set(name,value);}
    const contentType=response.headers.get('content-type')||'';
    const data=contentType.includes('application/json')?await response.json():await response.arrayBuffer();
    return{status:response.status,data,headers:response.headers};
  }
  return{request,cookies,get base(){return base;},get runtime(){return runtime;},restart:async()=>{runtime.close();await new Promise<void>(resolve=>server.close(()=>resolve()));runtime=await createApp({...options,dataDir,env,catalog:[product,privateProduct]});await listen();}};
}
const json=(value:unknown)=>JSON.stringify(value);
async function bootstrap(f:Awaited<ReturnType<typeof fixture>>){const result=await f.request('/api/bootstrap');assert.equal(result.status,200);return result.data.state as WorkspaceState;}
async function signup(f:Awaited<ReturnType<typeof fixture>>,email='account@example.test'){
  const password=randomBytes(20).toString('hex');assert.equal((await f.request('/api/auth/sign-up/email',{method:'POST',headers:{origin},body:json({name:'Designer',email,password})})).status,200);
  const boot=await f.request('/api/bootstrap');assert.equal(boot.status,200);return{password,email,workspaceId:boot.data.workspaceId as string,userId:boot.data.user.id as string,state:boot.data.state as WorkspaceState};
}

async function billingFixture(t:TestContext,interval:'monthly'|'annual'='monthly',initial='2026-10-16T10:00:00Z'){
  let current=new Date(initial);const webhookSecret=randomBytes(32).toString('hex');const anchor=Math.floor(current.getTime()/1000);
  const priceId=interval==='monthly'?'price_plus_monthly':'price_plus_annual';
  const subscription:Record<string,any>={id:'sub_monogram_test',customer:'cus_monogram_test',status:'active',metadata:{workspaceId:''},billing_cycle_anchor:anchor,cancel_at_period_end:false,items:{data:[{price:{id:priceId},current_period_start:anchor,current_period_end:addCalendarMonths(anchor,interval==='monthly'?1:12)}]},latest_invoice:'in_monogram_first'};
  const invoiceFor=(id='in_monogram_first')=>({id,customer:subscription.customer,status:'paid',parent:{subscription_details:{subscription:subscription.id}},lines:{data:[{pricing:{price_details:{price:subscription.items.data[0].price.id}},period:{start:subscription.items.data[0].current_period_start,end:subscription.items.data[0].current_period_end}}]}});
  const invoices=new Map<string,unknown>([['in_monogram_first',invoiceFor()]]);
  const provider=(async(input:unknown)=>{
    const url=String(input);if(url.endsWith('/checkout/sessions'))return Response.json({url:'https://checkout.stripe.com/c/pay/test-session'});
    if(url.endsWith(`/subscriptions/${subscription.id}`))return Response.json(subscription);
    if(url.includes('/invoices/')){const invoice=invoices.get(url.split('/').at(-1)!);return Response.json(invoice||{error:'Not found'},{status:invoice?200:404});}
    if(url.endsWith('/billing_portal/sessions'))return Response.json({url:'https://billing.stripe.com/p/session/test'});
    return Response.json({error:'Unknown endpoint'},{status:404});
  }) as typeof fetch;
  const f=await fixture(t,{env:{STRIPE_SECRET_KEY:'test-key',STRIPE_WEBHOOK_SECRET:webhookSecret,STRIPE_PRICE_PLUS_MONTHLY:'price_plus_monthly',STRIPE_PRICE_PLUS_ANNUAL:'price_plus_annual'},fetchImpl:provider,now:()=>current});
  const password=randomBytes(20).toString('hex');assert.equal((await f.request('/api/auth/sign-up/email',{method:'POST',headers:{origin},body:json({name:'Designer',email:'billing@example.test',password})})).status,200);
  const boot=await f.request('/api/bootstrap');subscription.metadata.workspaceId=boot.data.workspaceId;
  let eventNumber=0;
  async function event(type:string,item:unknown,id=`evt_${++eventNumber}`,created=Math.floor(current.getTime()/1000)+eventNumber){
    const body=json({id,type,created,data:{object:item}});const timestamp=String(Math.floor(current.getTime()/1000));const signature=createHmac('sha256',webhookSecret).update(`${timestamp}.${body}`).digest('hex');
    return f.request('/api/billing/webhook',{method:'POST',headers:{'stripe-signature':`t=${timestamp},v1=${signature}`},body});
  }
  const checkoutEvent=()=>event('checkout.session.completed',{subscription:subscription.id,invoice:'in_monogram_first',payment_status:'paid'},'evt_checkout');
  return{f,subscription,invoiceFor,invoices,event,checkoutEvent,anchor,workspaceId:boot.data.workspaceId as string,state:boot.data.state as WorkspaceState,setNow:(date:Date)=>{current=date;}};
}

test('localhost bootstrap creates a private cookie session; other hosts and unauthenticated writes are rejected',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/workspace')).status,401);
  const foreignHostStatus=await new Promise<number>(resolve=>{const request=httpRequest(`${f.base}/api/bootstrap`,{headers:{host:'untrusted.example'}},response=>{response.resume();resolve(response.statusCode||0);});request.end();});
  assert.equal(foreignHostStatus,401);
  const response=await f.request('/api/bootstrap');
  assert.equal(response.status,200);assert.ok(response.data.user.visitor);
  assert.ok(typeof response.data.workspaceId==='string');
  assert.ok(response.headers.getSetCookie().every(v=>v.includes('HttpOnly')&&v.includes('SameSite=Lax')));
  assert.deepEqual(response.data.capabilities,{ai:false,email:false,google:false,stripe:false,pinterest:false});
  assert.equal(response.data.state.products.length,2);
  const wrongWorkspace=await f.request('/api/workspace',{method:'PUT',body:json({state:response.data.state,baseRevision:0,workspaceId:'another-workspace'})});assert.equal(wrongWorkspace.status,403);
  const unchanged=await f.request('/api/workspace');assert.equal(unchanged.data.workspaceId,response.data.workspaceId);assert.equal(unchanged.data.state.revision,0);
  const denied=await f.request('/api/workspace',{method:'PUT',headers:{origin:'https://attacker.example'},body:json({state:response.data.state,baseRevision:0})});assert.equal(denied.status,403);
});

test('production callers can inspect public capabilities while an anonymous workspace stays protected',async t=>{
  const f=await fixture(t,{env:{NODE_ENV:'production',ALLOW_LOCAL_VISITOR:'false'}});
  assert.equal((await f.request('/api/bootstrap')).status,401);
  const flags=await f.request('/api/capabilities');assert.equal(flags.status,200);assert.deepEqual(flags.data,{ai:false,email:false,google:false,stripe:false,pinterest:false});
  assert.equal((await f.request('/api/workspace')).status,401);
});

test('workspace saves survive restart, enforce revisions, isolate sessions, and protect credits and plan',async t=>{
  const f=await fixture(t);const state=await bootstrap(f);
  state.projects[0].name='A persisted project';state.credits.daily=9999;state.plan='Plus';state.profile.verified=true;
  let response=await f.request('/api/workspace',{method:'PUT',body:json({state,baseRevision:0})});
  assert.equal(response.status,200);assert.equal(response.data.state.revision,1);
  assert.equal(response.data.state.credits.daily,20);assert.equal(response.data.state.plan,'Free');assert.equal(response.data.state.profile.verified,false);
  assert.equal((await f.request('/api/workspace',{method:'PUT',body:json({state,baseRevision:0})})).status,409);
  const malformed={...response.data.state,projects:[{id:'bad'}]};assert.equal((await f.request('/api/workspace',{method:'PUT',body:json({state:malformed,baseRevision:1})})).status,400);
  const firstCookie=f.cookies();const other=await f.request('/api/bootstrap',{headers:{cookie:''}});assert.equal(other.status,200);assert.equal(other.data.state.projects[0].name,'My first project');
  await f.restart();const stored=await f.request('/api/workspace',{headers:{cookie:firstCookie}});assert.equal(stored.data.state.projects[0].name,'A persisted project');assert.equal(stored.data.state.revision,1);
});

test('backup validation rejects malformed optional board and product metadata without changing durable state',async t=>{
  const f=await fixture(t);const state=await bootstrap(f);
  assert.equal((await f.request('/api/workspace/validate',{method:'POST',headers:{cookie:''},body:json({state})})).status,401);
  assert.equal((await f.request('/api/workspace/validate',{method:'POST',body:json({state})})).status,200);
  const invalidProfile={...state,profile:null};assert.equal((await f.request('/api/workspace/validate',{method:'POST',body:json({state:invalidProfile})})).status,400);
  const invalidMaterial=structuredClone(state);invalidMaterial.products[0].material={...defaultMaterial(),roughness:'invalid'} as never;assert.equal((await f.request('/api/workspace/validate',{method:'POST',body:json({state:invalidMaterial})})).status,400);
  const metadata={images:['https://images.example.test/gallery.jpg'],variantIds:['variant-1'],modelSize:[1,2,0],sampleKind:'alpha-plane',variants:[{name:'Variant',color:'#ffffff',productId:'variant-1'}],material:{...defaultMaterial(),ormMap:'/assets/orm.webp',transmissionMap:'/assets/transmission.webp',thicknessMap:'/assets/thickness.webp',normalScale:1.5,sheen:1,sheenColor:'#eeeeee',sheenRoughness:0.3,clearcoat:1,clearcoatRoughness:0.4,specularIntensity:0.5,aoMapIntensity:1,color:'#ffffff',mapTransforms:{diffuse:{x:1,y:2,rotation:0}}}};
  const enriched=structuredClone(state);Object.assign(enriched.products[0],metadata);assert.equal((await f.request('/api/workspace/validate',{method:'POST',body:json({state:enriched})})).status,200);
  for(const invalid of [{images:['javascript:alert(1)']},{variantIds:[null]},{modelSize:[1,-2,3]},{modelSize:[1,2]},{sampleKind:'invented'},{variants:[{name:'Variant',color:'#ffffff',productId:{id:'bad'}}]},{material:{...metadata.material,ormMap:'javascript:alert(1)'}},{material:{...metadata.material,normalScale:'wrong'}},{material:{...metadata.material,sheenColor:{value:'invalid'}}},{material:{...metadata.material,specularIntensity:'invalid'}},{material:{...metadata.material,mapTransforms:{normal:{x:0,y:1,rotation:0}}}}]){const candidate=structuredClone(enriched);Object.assign(candidate.products[0],invalid);assert.equal((await f.request('/api/workspace/validate',{method:'POST',body:json({state:candidate})})).status,400);}
  const board=state.projects[0].boards[0];board.items.push({id:'canvas-item',name:'Text',kind:'text',shape:'plane',color:'#fff',position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],locked:false,visible:true,material:defaultMaterial(),canvas:{type:'text',x:0,y:0,width:100,height:100,rotation:0}});
  const valid=await f.request('/api/workspace/validate',{method:'POST',body:json({state})});assert.equal(valid.status,200);assert.deepEqual(valid.data,{valid:true});
  const invalidCanvas=structuredClone(state);invalidCanvas.projects[0].boards[0].items[0].canvas!.points=[[1,'invalid']] as never;assert.equal((await f.request('/api/workspace/validate',{method:'POST',body:json({state:invalidCanvas})})).status,400);
  const invalidNotes=structuredClone(state);invalidNotes.projects[0].boards[0].items[0].notes={private:'wrong shape'} as never;assert.equal((await f.request('/api/workspace/validate',{method:'POST',body:json({state:invalidNotes})})).status,400);
  const overrides=structuredClone(state);Object.assign(overrides.projects[0].boards[0].items[0],{colorOverride:true,materialOverrides:{roughness:0.4,sheen:1,ormMap:'/assets/orm.webp',mapTransforms:{orm:{x:2,y:2,rotation:0.2}}}});assert.equal((await f.request('/api/workspace/validate',{method:'POST',body:json({state:overrides})})).status,200);
  Object.assign(overrides.projects[0].boards[0].items[0],{materialOverrides:{roughness:'invalid'}});assert.equal((await f.request('/api/workspace/validate',{method:'POST',body:json({state:overrides})})).status,400);
  const stored=await f.request('/api/workspace');assert.equal(stored.data.state.revision,0);assert.equal(stored.data.state.projects[0].boards[0].items.length,0);
});

test('Better Auth email sign-up, session, sign-out and sign-in use real persistent credentials',async t=>{
  const f=await fixture(t);const guest=await bootstrap(f);guest.projects[0].name='Before account';
  assert.equal((await f.request('/api/workspace',{method:'PUT',body:json({state:guest,baseRevision:0})})).status,200);
  const password=randomBytes(20).toString('hex');const email='designer@example.test';
  const signup=await f.request('/api/auth/sign-up/email',{method:'POST',headers:{origin},body:json({name:'Designer',email,password})});
  assert.equal(signup.status,200,'Sign-up should succeed');
  let boot=await f.request('/api/bootstrap');assert.equal(boot.status,200);assert.equal(boot.data.user.visitor,false);assert.equal(boot.data.state.profile.email,email);assert.equal(boot.data.state.projects[0].name,'Before account');
  const record=f.runtime.db.prepare('SELECT password FROM account WHERE providerId=?').get('credential') as {password:string};assert.ok(record&&record.password!==password,'The stored credential must be hashed');
  assert.equal((await f.request('/api/auth/sign-out',{method:'POST',headers:{origin},body:'{}'})).status,200);
  assert.equal((await f.request('/api/workspace')).status,401);
  assert.equal((await f.request('/api/auth/sign-in/email',{method:'POST',headers:{origin},body:json({email,password:'incorrect-password'})})).status,401);
  assert.equal((await f.request('/api/auth/sign-in/email',{method:'POST',headers:{origin},body:json({email,password})})).status,200);
  boot=await f.request('/api/bootstrap');assert.equal(boot.data.state.projects[0].name,'Before account');
});

test('daily credits refresh once per configured calendar day and do not accumulate',async t=>{
  let current=new Date('2026-10-16T10:00:00Z');const f=await fixture(t,{now:()=>current});await bootstrap(f);
  const workspace=f.runtime.db.prepare('SELECT id FROM workspaces').get() as {id:string};
  f.runtime.store.mutate(workspace.id,state=>{state.credits.daily=3;});
  current=new Date('2026-10-17T10:00:00Z');
  const first=await f.request('/api/workspace');const second=await f.request('/api/workspace');
  assert.equal(first.data.state.credits.daily,20);assert.equal(second.data.state.revision,first.data.state.revision);
  assert.equal(first.data.state.credits.history[0].amount,17);
});

test('SSE announces workspace revisions to another browser connection',async t=>{
  const f=await fixture(t);const state=await bootstrap(f);const abort=new AbortController();
  const stream=await fetch(`${f.base}/api/events`,{headers:{cookie:f.cookies()},signal:abort.signal});assert.equal(stream.status,200);
  const reader=stream.body!.getReader();const initial=await reader.read();assert.match(new TextDecoder().decode(initial.value),/event: workspace\ndata: \{"revision":0\}/);
  state.projects[0].name='Changed elsewhere';assert.equal((await f.request('/api/workspace',{method:'PUT',body:json({state,baseRevision:0})})).status,200);
  const update=await reader.read();assert.match(new TextDecoder().decode(update.value),/"revision":1/);abort.abort();await reader.cancel().catch(()=>{});
});

test('uploads verify file signatures, return usable opaque URLs, and reject active SVG and oversized files',async t=>{
  const f=await fixture(t);await bootstrap(f);
  let form=new FormData();form.set('file',new Blob(['<svg onload="alert(1)"></svg>'],{type:'image/svg+xml'}),'unsafe.svg');assert.equal((await f.request('/api/upload',{method:'POST',body:form})).status,415);
  form=new FormData();form.set('file',new Blob([png],{type:'image/png'}),'sample.png');const uploaded=await f.request('/api/upload',{method:'POST',body:form});assert.equal(uploaded.status,201);assert.equal(uploaded.data.name,'sample.png');
  const file=await f.request(uploaded.data.url);assert.equal(file.status,200);assert.equal(file.headers.get('content-type'),'image/png');assert.ok(Buffer.from(file.data).equals(png));
  form=new FormData();form.set('file',new Blob([new Uint8Array(21*1024*1024)],{type:'image/png'}),'large.png');assert.equal((await f.request('/api/upload',{method:'POST',body:form})).status,413);
});

test('share view/review/edit permissions, private product boundaries, conflicts and owner-only revocation are enforced',async t=>{
  const f=await fixture(t);let state=await bootstrap(f);const project=state.projects[0];const schedule=project.schedules[0];
  schedule.rows.push({id:'row-1',productId:product.id,groupId:'default',values:{remarks:'Keep this'},status:'Draft'});schedule.shareToken='private-owner-token';
  project.boards[0].items.push({id:'item-1',productId:product.id,kind:'material',name:'Sample',shape:'box',color:'#aaaaaa',position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],locked:false,visible:true,material:defaultMaterial()});
  let saved=await f.request('/api/workspace',{method:'PUT',body:json({state,baseRevision:0})});assert.equal(saved.status,200);state=saved.data.state;
  async function create(access:string,kind='schedule',resourceId=schedule.id){const response=await f.request('/api/share',{method:'POST',body:json({kind,projectId:project.id,resourceId,access})});assert.equal(response.status,201);return response.data.token as string;}
  const view=await create('view');const review=await create('review');const edit=await create('edit');
  const publicRead=await f.request(`/api/share/${view}`,{headers:{cookie:''}});assert.equal(publicRead.status,200);assert.equal(publicRead.data.products.length,1);assert.equal(publicRead.data.products[0].id,product.id);assert.ok(!('profile' in publicRead.data));assert.ok(!('shareToken' in publicRead.data.resource));
  const reviewBody={rowId:'row-1',status:'approved'};
  assert.equal((await f.request(`/api/share/${view}`,{method:'PATCH',headers:{cookie:''},body:json(reviewBody)})).status,403);
  assert.equal((await f.request(`/api/share/${review}`,{method:'PATCH',headers:{cookie:''},body:json({...reviewBody,values:{price:0}})})).status,400);
  assert.equal((await f.request(`/api/share/${review}`,{method:'PATCH',headers:{cookie:''},body:json({...reviewBody,remarks:'Approved finish'})})).status,200);
  saved=await f.request('/api/workspace');assert.equal(saved.data.state.projects[0].schedules[0].rows[0].status,'Approved');assert.equal(saved.data.state.projects[0].schedules[0].rows[0].values.remarks,'Approved finish');
  const resource=structuredClone(saved.data.state.projects[0].schedules[0]);resource.name='Shared edit';
  assert.equal((await f.request(`/api/share/${review}`,{method:'PUT',headers:{cookie:''},body:json({resource,baseRevision:saved.data.state.revision})})).status,403);
  assert.equal((await f.request(`/api/share/${edit}`,{method:'PUT',headers:{cookie:''},body:json({resource,baseRevision:saved.data.state.revision})})).status,200);
  assert.equal((await f.request(`/api/share/${edit}`,{method:'PUT',headers:{cookie:''},body:json({resource,baseRevision:saved.data.state.revision})})).status,409);
  resource.rows[0].productId=privateProduct.id;
  assert.equal((await f.request(`/api/share/${edit}`,{method:'PUT',headers:{cookie:''},body:json({resource,baseRevision:saved.data.state.revision+1})})).status,403);
  assert.equal((await f.request(`/api/share/${view}`,{method:'DELETE',headers:{cookie:''}})).status,401);
  assert.equal((await f.request(`/api/share/${view}`,{method:'DELETE'})).status,200);assert.equal((await f.request(`/api/share/${view}`)).status,404);
  const boardView=await create('view','board',project.boards[0].id);assert.equal((await f.request(`/api/share/${boardView}`,{method:'PATCH',body:json(reviewBody)})).status,403);
});

test('upload reads require ownership or a current board/schedule share reference and revocation closes access',async t=>{
  const f=await fixture(t);let state=await bootstrap(f);const owner=f.cookies();
  async function upload(){const form=new FormData();form.set('file',new Blob([png],{type:'image/png'}),'private.png');const response=await f.request('/api/upload',{method:'POST',body:form,headers:{cookie:owner}});assert.equal(response.status,201);return response.data.url as string;}
  const image=await upload(),unlisted=await upload();
  state.products.find(product=>product.id===privateProduct.id)!.image=image;const project=state.projects[0];project.boards[0].items.push({id:'shared-image-item',productId:privateProduct.id,kind:'material',name:'Private sample',shape:'box',color:'#aaaaaa',position:[0,0,0],rotation:[0,0,0],scale:[1,1,1],locked:false,visible:true,material:defaultMaterial()});project.schedules[0].rows.push({id:'image-row',productId:privateProduct.id,groupId:'default',values:{},status:'Draft'});
  let saved=await f.request('/api/workspace',{method:'PUT',headers:{cookie:owner},body:json({state,baseRevision:state.revision})});assert.equal(saved.status,200);state=saved.data.state;
  assert.equal((await f.request(image,{headers:{cookie:''}})).status,404);assert.equal((await f.request(image,{headers:{cookie:owner}})).status,200);
  await f.request('/api/bootstrap',{headers:{cookie:''}});assert.equal((await f.request(image)).status,404);
  const create=async(kind:'board'|'schedule',resourceId:string)=>{const result=await f.request('/api/share',{method:'POST',headers:{cookie:owner},body:json({kind,projectId:project.id,resourceId,access:'view'})});assert.equal(result.status,201);return result.data.token as string;};
  const board=await create('board',project.boards[0].id);assert.equal((await f.request(image,{headers:{cookie:''}})).status,200);assert.equal((await f.request(unlisted,{headers:{cookie:''}})).status,404);
  assert.equal((await f.request(`/api/share/${board}`,{method:'DELETE',headers:{cookie:owner}})).status,200);assert.equal((await f.request(image,{headers:{cookie:''}})).status,404);
  const schedule=await create('schedule',project.schedules[0].id);assert.equal((await f.request(image,{headers:{cookie:''}})).status,200);
  state.projects[0].schedules[0].rows=[];saved=await f.request('/api/workspace',{method:'PUT',headers:{cookie:owner},body:json({state,baseRevision:state.revision})});assert.equal(saved.status,200);assert.equal((await f.request(`/api/share/${schedule}`,{headers:{cookie:''}})).status,200);assert.equal((await f.request(image,{headers:{cookie:''}})).status,404);assert.equal((await f.request(image,{headers:{cookie:owner}})).status,200);
});

test('collaboration media follows its allowlist and library copies retain independent actual files after revocation',async t=>{
  const f=await fixture(t);let state=await bootstrap(f);const ownerCookie=f.cookies(),ownerBoot=await f.request('/api/bootstrap');const ownerId=ownerBoot.data.workspaceId as string;
  async function upload(){const form=new FormData();form.set('file',new Blob([png],{type:'image/png'}),'library.png');const result=await f.request('/api/upload',{method:'POST',body:form,headers:{cookie:ownerCookie}});assert.equal(result.status,201);return result.data.url as string;}
  const image=await upload(),hiddenImage=await upload();state.plan='Plus';state.products.find(product=>product.id===privateProduct.id)!.image=image;state.products.find(product=>product.id===privateProduct.id)!.material={...defaultMaterial(),texture:image};state.libraries[0].productIds=[privateProduct.id];state.projects[0].drawer=[privateProduct.id];f.runtime.store.save(ownerId,state);
  const create=async(kind:'projects'|'libraries',id:string)=>{const result=await f.request(`/api/collaboration/${kind}/${id}/links`,{method:'POST',headers:{cookie:ownerCookie},body:json({access:'view'})});assert.equal(result.status,201);return result.data;};
  const projectLink=await create('projects',state.projects[0].id);assert.equal((await f.request(image,{headers:{cookie:''}})).status,200);
  f.runtime.store.mutate(ownerId,draft=>{draft.products.push({...privateProduct,id:'hidden-after-link',image:hiddenImage});draft.projects[0].drawer.push('hidden-after-link');});assert.equal((await f.request(hiddenImage,{headers:{cookie:''}})).status,404);
  assert.equal((await f.request(`/api/collaboration/links/${projectLink.link.id}`,{method:'DELETE',headers:{cookie:ownerCookie}})).status,200);assert.equal((await f.request(image,{headers:{cookie:''}})).status,404);
  const libraryLink=await create('libraries',state.libraries[0].id);assert.equal((await f.request(image,{headers:{cookie:''}})).status,200);
  const viewer=await f.request('/api/bootstrap',{headers:{cookie:''}}),viewerCookie=f.cookies(),viewerId=viewer.data.workspaceId as string;
  const uploadRows=()=>Number((f.runtime.db.prepare('SELECT COUNT(*) AS total FROM uploads').get() as {total:number}).total),before=uploadRows();
  const dataPath=(f.runtime.db.prepare('PRAGMA database_list').get() as {file:string}).file,filesBefore=readdirSync(path.join(path.dirname(dataPath),'uploads')).length;
  assert.equal((await f.request(`/api/collaboration/share/${libraryLink.token}/copy`,{method:'POST',body:'{}',headers:{cookie:viewerCookie}})).status,402);assert.equal(uploadRows(),before);assert.equal(readdirSync(path.join(path.dirname(dataPath),'uploads')).length,filesBefore,'Quota rejection must clean up prepared files');
  const viewerState=f.runtime.store.get(viewerId).state;viewerState.profile.verified=true;viewerState.products.push(...Array.from({length:29},(_,index)=>({...privateProduct,id:`verified-limit-${index}`})));f.runtime.store.save(viewerId,viewerState);
  assert.equal((await f.request(`/api/collaboration/share/${libraryLink.token}/copy`,{method:'POST',body:'{}',headers:{cookie:viewerCookie}})).status,402);assert.equal(uploadRows(),before);assert.equal(readdirSync(path.join(path.dirname(dataPath),'uploads')).length,filesBefore,'Verified Free saved-asset quota failure also cleans prepared files');
  viewerState.products=viewerState.products.filter(product=>!product.id.startsWith('verified-limit-'));f.runtime.store.save(viewerId,viewerState);
  const copied=await f.request(`/api/collaboration/share/${libraryLink.token}/copy`,{method:'POST',body:'{}',headers:{cookie:viewerCookie}});assert.equal(copied.status,201);const library=copied.data.state.libraries.find((item:{id:string})=>item.id===copied.data.libraryId),copiedProduct=copied.data.state.products.find((item:Product)=>item.id===library.productIds[0]);assert.ok(copiedProduct.image!==image);assert.equal(copiedProduct.material.texture,copiedProduct.image);assert.equal(uploadRows(),before+1,'The same file used by two fields is copied once');
  const file=await f.request(copiedProduct.image,{headers:{cookie:viewerCookie}});assert.equal(file.status,200);assert.ok(Buffer.from(file.data).equals(png));assert.equal((await f.request(copiedProduct.image,{headers:{cookie:''}})).status,404);assert.equal((await f.request(copiedProduct.image,{headers:{cookie:ownerCookie}})).status,404);
  assert.equal((await f.request(`/api/collaboration/links/${libraryLink.link.id}`,{method:'DELETE',headers:{cookie:ownerCookie}})).status,200);assert.equal((await f.request(image,{headers:{cookie:''}})).status,404);assert.equal((await f.request(copiedProduct.image,{headers:{cookie:viewerCookie}})).status,200);assert.equal((await f.request(image,{headers:{cookie:ownerCookie}})).status,200);
  // A link owner cannot publish or copy another workspace's private upload merely by naming its URL.
  f.runtime.store.mutate(ownerId,draft=>{draft.products.find(product=>product.id===privateProduct.id)!.model=copiedProduct.image;});const invalidLink=await create('libraries',state.libraries[0].id);const unrelated=await f.request('/api/bootstrap',{headers:{cookie:''}});f.runtime.store.mutate(unrelated.data.workspaceId,draft=>{draft.profile.verified=true;});const unrelatedCookie=f.cookies(),rowsBefore=uploadRows(),remainingFiles=readdirSync(path.join(path.dirname(dataPath),'uploads')).length;
  assert.equal((await f.request(copiedProduct.image,{headers:{cookie:''}})).status,404);assert.equal((await f.request(`/api/collaboration/share/${invalidLink.token}/copy`,{method:'POST',body:'{}',headers:{cookie:unrelatedCookie}})).status,403);assert.equal(uploadRows(),rowsBefore);assert.equal(readdirSync(path.join(path.dirname(dataPath),'uploads')).length,remainingFiles);
});

test('supplier requests create a real inbox record without claiming unconfigured email delivery',async t=>{
  const f=await fixture(t);await bootstrap(f);
  const response=await f.request('/api/requests',{method:'POST',body:json({productIds:[product.id],type:'quote',name:'Designer',email:'designer@example.test',message:'Please quote.'})});
  assert.equal(response.status,201);assert.equal(response.data.delivery,'internal');assert.equal(response.data.request.status,'submitted');assert.ok(response.data.state.inbox.length>0);
  assert.match(response.data.message,/no supplier email was sent/i);
});

test('unconfigured AI and billing fail honestly without credits or plan changes',async t=>{
  const f=await fixture(t);const state=await bootstrap(f);
  assert.equal((await f.request('/api/ai/render',{method:'POST',body:json({prompt:'Render a room'})})).status,503);
  assert.equal((await f.request('/api/billing/checkout',{method:'POST',body:json({plan:'Plus',period:'monthly'})})).status,503);
  assert.equal((await f.request('/api/auth/request-password-reset',{method:'POST',headers:{origin},body:json({email:'designer@example.test',redirectTo:`${origin}/reset-password`})})).status,503);
  const saved=await f.request('/api/workspace');assert.equal(saved.data.state.credits.daily,state.credits.daily);assert.equal(saved.data.state.plan,'Free');
});

test('password reset uses the configured mail gateway and rejects delivery failures',async t=>{
  let succeed=true;let calls=0;
  const provider=(async(_input:unknown,init?:RequestInit)=>{calls++;const body=JSON.parse(String(init?.body));assert.deepEqual(body.to,['reset@example.test']);assert.ok(body.subject.includes('monogram'));assert.ok(body.text.includes('/api/auth/reset-password/'));return Response.json(succeed?{id:'accepted'}:{error:'failed'},{status:succeed?200:503});}) as typeof fetch;
  const f=await fixture(t,{env:{MAIL_SEND_ENDPOINT:'https://mail.example.test/send',MAIL_API_KEY:'test-key',MAIL_FROM:'studio@example.test'},fetchImpl:provider});
  const password=randomBytes(20).toString('hex');assert.equal((await f.request('/api/auth/sign-up/email',{method:'POST',headers:{origin},body:json({name:'Designer',email:'reset@example.test',password})})).status,200);
  const body=json({email:'reset@example.test',redirectTo:`${origin}/reset-password`});
  assert.equal((await f.request('/api/auth/request-password-reset',{method:'POST',headers:{origin},body})).status,200);assert.equal(calls,1);
  succeed=false;assert.equal((await f.request('/api/auth/request-password-reset',{method:'POST',headers:{origin},body})).status,503);assert.equal(calls,2);
});

test('configured mail submits only to the operator mailbox and preserves failed requests',async t=>{
  let succeed=true;let calls=0;
  const provider=(async(_input:unknown,init?:RequestInit)=>{calls++;const body=JSON.parse(String(init?.body));assert.deepEqual(body.to,['requests@example.test']);assert.equal(body.reply_to,'designer@example.test');return Response.json(succeed?{id:'mail-accepted'}:{error:'failed'},{status:succeed?200:503});}) as typeof fetch;
  const f=await fixture(t,{env:{MAIL_SEND_ENDPOINT:'https://mail.example.test/send',MAIL_API_KEY:'test-key',MAIL_FROM:'studio@example.test',REQUESTS_TO:'requests@example.test'},fetchImpl:provider});await bootstrap(f);
  const body=json({productIds:[product.id],type:'sample',name:'Designer',email:'designer@example.test',message:'Please send a sample.',supplier:'arbitrary@example.test'});
  const accepted=await f.request('/api/requests',{method:'POST',body});assert.equal(accepted.status,201);assert.equal(accepted.data.request.status,'sent');assert.equal(accepted.data.delivery,'sent');
  succeed=false;const failed=await f.request('/api/requests',{method:'POST',body});assert.equal(failed.status,201);assert.equal(failed.data.delivery,'failed');assert.equal(failed.data.request.status,'failed');assert.equal(failed.data.state.requests.length,2);assert.equal(calls,2);
});

test('Stripe checkout does not grant a plan; signed idempotent webhooks control entitlements',async t=>{
  const b=await billingFixture(t);const {f,state}=b;
  const checkout=await f.request('/api/billing/checkout',{method:'POST',body:json({plan:'Plus',period:'monthly'})});assert.equal(checkout.status,200);assert.ok(checkout.data.url.startsWith('https://checkout.stripe.com/'));
  assert.equal((await f.request('/api/workspace')).data.state.plan,'Free');
  assert.equal((await f.request('/api/billing/webhook',{method:'POST',headers:{'stripe-signature':'invalid'},body:json({id:'evt-invalid'})})).status,400);
  assert.equal((await b.checkoutEvent()).status,200);
  const active=await f.request('/api/workspace');assert.equal(active.data.state.plan,'Plus');assert.equal(active.data.state.credits.monthly,2500);assert.equal(active.data.state.revision,state.revision+1);
  assert.equal((await b.checkoutEvent()).status,200);assert.equal((await f.request('/api/workspace')).data.state.revision,active.data.state.revision);
  assert.equal((await f.request('/api/billing/checkout',{method:'POST',body:json({plan:'Plus',period:'monthly'})})).status,409);
  assert.equal((await f.request('/api/billing/portal',{method:'POST',body:'{}'})).status,200);
});

test('paid invoice renewal resets monthly credits once without accumulating or resetting on duplicate invoices',async t=>{
  const b=await billingFixture(t);assert.equal((await b.checkoutEvent()).status,200);
  b.f.runtime.store.mutate(b.workspaceId,state=>{state.credits.monthly=100;});
  assert.equal((await b.event('invoice.paid',b.invoiceFor(),'evt_invoice_same_period')).status,200);assert.equal((await b.f.request('/api/workspace')).data.state.credits.monthly,100);
  const start=addCalendarMonths(b.anchor,1);b.setNow(new Date((start+1)*1000));b.subscription.items.data[0].current_period_start=start;b.subscription.items.data[0].current_period_end=addCalendarMonths(b.anchor,2);
  assert.equal((await b.event('invoice.paid',b.invoiceFor('in_second'))).status,200);
  let state=(await b.f.request('/api/workspace')).data.state;assert.equal(state.plan,'Plus');assert.equal(state.credits.monthly,2500);
  b.f.runtime.store.mutate(b.workspaceId,state=>{state.credits.monthly=2200;});
  assert.equal((await b.event('invoice.paid',b.invoiceFor('in_second'),'evt_duplicate_invoice_new_event')).status,200);
  state=(await b.f.request('/api/workspace')).data.state;assert.equal(state.credits.monthly,2200);
});

test('an annually paid Plus subscription receives a monthly allowance and expires at its paid-through deadline',async t=>{
  const b=await billingFixture(t,'annual','2026-01-31T10:00:00Z');assert.equal((await b.checkoutEvent()).status,200);
  b.f.runtime.store.mutate(b.workspaceId,state=>{state.credits.monthly=12;});
  b.setNow(new Date(addCalendarMonths(b.anchor,1)*1000));let state=(await b.f.request('/api/workspace')).data.state;assert.equal(state.credits.monthly,2500);
  assert.equal(new Date(addCalendarMonths(b.anchor,1)*1000).getUTCDate(),28);assert.equal(new Date(addCalendarMonths(b.anchor,2)*1000).getUTCDate(),31);
  b.f.runtime.store.mutate(b.workspaceId,state=>{state.credits.monthly=900;});
  b.setNow(new Date(addCalendarMonths(b.anchor,6)*1000));state=(await b.f.request('/api/workspace')).data.state;assert.equal(state.credits.monthly,2500);
  b.setNow(new Date(addCalendarMonths(b.anchor,12)*1000));state=(await b.f.request('/api/workspace')).data.state;assert.equal(state.plan,'Free');assert.equal(state.credits.monthly,0);
});

test('scheduled cancellation retains paid access; immediate cancellation and older events cannot restore credits',async t=>{
  const b=await billingFixture(t);assert.equal((await b.checkoutEvent()).status,200);
  b.subscription.cancel_at_period_end=true;assert.equal((await b.event('customer.subscription.updated',b.subscription,'evt_scheduled',b.anchor+10)).status,200);
  let state=(await b.f.request('/api/workspace')).data.state;assert.equal(state.plan,'Plus');assert.equal(state.credits.monthly,2500);
  const billing=await b.f.request('/api/billing/status');assert.equal(billing.data.cancelAtPeriodEnd,true);
  const oldActive=structuredClone(b.subscription);b.subscription.status='canceled';assert.equal((await b.event('customer.subscription.deleted',b.subscription,'evt_cancelled',b.anchor+20)).status,200);
  state=(await b.f.request('/api/workspace')).data.state;assert.equal(state.plan,'Free');assert.equal(state.credits.monthly,0);
  assert.equal((await b.event('customer.subscription.updated',oldActive,'evt_old_update',b.anchor+5)).status,200);
  assert.equal((await b.event('invoice.paid',b.invoiceFor(),'evt_late_paid',b.anchor+6)).status,200);
  state=(await b.f.request('/api/workspace')).data.state;assert.equal(state.plan,'Free');assert.equal(state.credits.monthly,0);
});

test('subscription period extension without a paid invoice does not grant a new month of credits',async t=>{
  const b=await billingFixture(t);assert.equal((await b.checkoutEvent()).status,200);
  b.setNow(new Date((addCalendarMonths(b.anchor,1)+1)*1000));b.subscription.items.data[0].current_period_start=addCalendarMonths(b.anchor,1);b.subscription.items.data[0].current_period_end=addCalendarMonths(b.anchor,2);
  assert.equal((await b.event('customer.subscription.updated',b.subscription)).status,200);
  const state=(await b.f.request('/api/workspace')).data.state;assert.equal(state.plan,'Free');assert.equal(state.credits.monthly,0);
});

test('configured AI calls its provider, charges only successful renders, and persists results',async t=>{
  let calls=0;let succeed=true;
  const provider=(async(_input:unknown,init?:RequestInit)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.prompt,'Render a room');return succeed?Response.json({data:[{url:'https://images.example.test/render.png'}]}):Response.json({error:'down'},{status:503});}) as typeof fetch;
  const f=await fixture(t,{env:{AI_RENDER_ENDPOINT:'https://gateway.example.test/render',AI_API_KEY:'test-key',AI_CREDITS_PER_RENDER:'10'},fetchImpl:provider});await bootstrap(f);
  const result=await f.request('/api/ai/render',{method:'POST',body:json({prompt:'Render a room'})});assert.equal(result.status,201);assert.equal(result.data.creditsSpent,10);assert.equal(result.data.state.credits.daily,10);assert.equal(calls,1);
  succeed=false;assert.equal((await f.request('/api/ai/render',{method:'POST',body:json({prompt:'Render a room'})})).status,502);
  const workspace=await f.request('/api/workspace');assert.equal(workspace.data.state.credits.daily,10);
  const history=await f.request('/api/ai/renders');assert.equal(history.data.renders.length,1);
});

test('environment files load local before base and preserve existing process values',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'monogram-env-'));const prefix=`MONOGRAM_TEST_${randomBytes(6).toString('hex').toUpperCase()}`;
  const names=[`${prefix}_EXISTING`,`${prefix}_LOCAL`,`${prefix}_BASE`];
  try{
    process.env[names[0]]='process';
    writeFileSync(path.join(directory,'.env.local'),`${names[0]}=local\n${names[1]}=local\n`);
    writeFileSync(path.join(directory,'.env'),`${names[0]}=base\n${names[1]}=base\n${names[2]}=base\n`);
    loadEnvFiles(directory);assert.equal(process.env[names[0]],'process');assert.equal(process.env[names[1]],'local');assert.equal(process.env[names[2]],'base');
    loadEnvFiles(path.join(directory,'missing'));
  }finally{for(const name of names)delete process.env[name];rmSync(directory,{recursive:true,force:true});}
});

test('applications are validated, persisted, isolated and migrated without granting approval',async t=>{
  const f=await fixture(t);await bootstrap(f);
  const input={type:'education',name:'Student',organization:'Design school',email:'student@example.test',country:'Korea',course:'Interior design',graduationDate:'2027-02-28',website:'https://example.test/portfolio',evidenceUrl:'https://example.test/evidence',message:'Please review my student eligibility.'};
  for(const invalid of [{...input,email:'invalid'},{...input,website:'javascript:alert(1)'},{...input,graduationDate:'2027-02-30'},{...input,message:'short'},{...input,country:{value:'wrong'}}])assert.equal((await f.request('/api/applications',{method:'POST',body:json(invalid)})).status,400);
  const submitted=await f.request('/api/applications',{method:'POST',body:json(input)});assert.equal(submitted.status,201);assert.equal(submitted.data.application.status,'submitted');assert.equal(submitted.data.state.profile.verified,false);assert.equal(submitted.data.state.plan,'Free');assert.match(submitted.data.message,/awaiting review/);
  assert.equal((await f.request('/api/applications',{method:'POST',body:json(input)})).status,409);
  const account=await signup(f,'student@example.test');assert.equal(account.state.profile.verified,false);
  await f.restart();const listed=await f.request('/api/applications');assert.equal(listed.data.applications.length,1);assert.equal(listed.data.applications[0].course,input.course);
  for(const type of ['designer','enterprise','supplier'])assert.equal((await f.request('/api/applications',{method:'POST',body:json({...input,type})})).status,201);
  const originalCookie=f.cookies();await f.request('/api/bootstrap',{headers:{cookie:''}});const visitorCookie=f.cookies().split('; ').find(cookie=>cookie.startsWith('monogram.visitor='))!;assert.equal((await f.request('/api/applications',{headers:{cookie:visitorCookie}})).data.applications.length,0);
  assert.equal((await f.request('/api/applications',{headers:{cookie:originalCookie}})).data.applications.length,4);
});

test('account passwords require the current secret, preserve active login and revoke other sessions',async t=>{
  const f=await fixture(t);await bootstrap(f);assert.equal((await f.request('/api/account/password',{method:'POST',body:json({newPassword:'new-password-123'})})).status,401);
  const account=await signup(f);const oldCookie=f.cookies();
  const status=await f.request('/api/account/status');assert.equal(status.data.authenticated,true);assert.equal(status.data.hasPassword,true);assert.ok(!('password' in status.data));
  const before=f.runtime.db.prepare("SELECT password FROM account WHERE userId=? AND providerId='credential'").get(account.userId) as {password:string};
  assert.equal((await f.request('/api/account/password',{method:'POST',body:json({newPassword:'replacement-password'})})).status,400);
  assert.equal((await f.request('/api/account/password',{method:'POST',body:json({currentPassword:'wrong-password',newPassword:'replacement-password'})})).status,400);
  const after=f.runtime.db.prepare("SELECT password FROM account WHERE userId=? AND providerId='credential'").get(account.userId) as {password:string};assert.ok(before.password===after.password,'Rejected changes must preserve the hash');
  const changed=await f.request('/api/account/password',{method:'POST',body:json({currentPassword:account.password,newPassword:'replacement-password'})});assert.equal(changed.status,200);assert.deepEqual(changed.data,{status:true});
  assert.equal((await f.request('/api/workspace')).status,200);assert.equal((await f.request('/api/workspace',{headers:{cookie:oldCookie}})).status,401);
  await f.request('/api/auth/sign-out',{method:'POST',headers:{origin},body:'{}'});
  assert.equal((await f.request('/api/auth/sign-in/email',{method:'POST',headers:{origin},body:json({email:account.email,password:account.password})})).status,401);
  assert.equal((await f.request('/api/auth/sign-in/email',{method:'POST',headers:{origin},body:json({email:account.email,password:'replacement-password'})})).status,200);
});

test('a social-only account can add a password only with a recently authenticated session',async t=>{
  const f=await fixture(t);const account=await signup(f,'social@example.test');
  f.runtime.db.prepare("UPDATE account SET providerId='google',password=NULL WHERE userId=? AND providerId='credential'").run(account.userId);
  assert.equal((await f.request('/api/account/status')).data.hasPassword,false);
  const session=f.runtime.db.prepare('SELECT id,createdAt FROM session WHERE userId=?').get(account.userId) as {id:string;createdAt:number|string};
  // Better Auth's authoritative sensitive-session check does not enforce recency itself.
  f.runtime.db.prepare('UPDATE session SET createdAt=? WHERE id=?').run(Date.now()-60*60*1000,session.id);
  assert.equal((await f.request('/api/account/password',{method:'POST',body:json({newPassword:'social-new-password'})})).status,403);
  assert.ok(!f.runtime.db.prepare("SELECT id FROM account WHERE userId=? AND providerId='credential'").get(account.userId));
  f.runtime.db.prepare('UPDATE session SET createdAt=? WHERE id=?').run(Date.now(),session.id);
  assert.equal((await f.request('/api/account/password',{method:'POST',body:json({newPassword:'social-new-password'})})).status,200);
  assert.equal((await f.request('/api/account/status')).data.hasPassword,true);
  assert.equal((await f.request('/api/account/password',{method:'POST',body:json({newPassword:'unauthorized-replacement'})})).status,400);
});

test('plan quotas reject increases atomically while preserving and allowing edits to grandfathered work',async t=>{
  const f=await fixture(t);let state=await bootstrap(f);const boot=await f.request('/api/bootstrap');const workspaceId=boot.data.workspaceId as string;
  const save=(candidate:WorkspaceState)=>f.request('/api/workspace',{method:'PUT',body:json({state:candidate,baseRevision:candidate.revision})});
  const extraProject=structuredClone(state.projects[0]);extraProject.id='another-project';state.projects.push(extraProject);
  assert.equal((await save(state)).status,402);assert.equal((await f.request('/api/workspace')).data.state.revision,0);
  state=(await f.request('/api/workspace')).data.state;state.libraries.push({...state.libraries[0],id:'another-library'});assert.equal((await save(state)).status,402);
  state=(await f.request('/api/workspace')).data.state;
  state.products.push(...Array.from({length:30},(_,index)=>({...privateProduct,id:`custom-${index}`})));assert.equal((await save(state)).status,402);
  for(const item of state.products)item.custom=false;assert.equal((await save(state)).status,402,'Client flags cannot disguise imported products as server catalog assets');
  // Simulate legitimate work retained after downgrading an older paid account.
  state=(await f.request('/api/workspace')).data.state;state.products.push(...Array.from({length:34},(_,index)=>({...privateProduct,id:`existing-${index}`})));f.runtime.store.save(workspaceId,state);
  state.projects[0].name='Retained work';let result=await save(state);assert.equal(result.status,200);state=result.data.state;
  state.products.push({...privateProduct,id:'one-too-many'});assert.equal((await save(state)).status,402);
  state=(await f.request('/api/workspace')).data.state;state.products=state.products.filter(p=>p.id!=='existing-0');result=await save(state);assert.equal(result.status,200);state=result.data.state;state.products.push({...privateProduct,id:'replacement-above-limit'});assert.equal((await save(state)).status,402);
  state=(await f.request('/api/workspace')).data.state;state.plan='Starter';f.runtime.store.save(workspaceId,state);
  state.projects.push({...extraProject,id:'starter-2'},{...extraProject,id:'starter-3'});result=await save(state);assert.equal(result.status,200);state=result.data.state;state.projects.push({...extraProject,id:'starter-4'});assert.equal((await save(state)).status,402);
  state=(await f.request('/api/workspace')).data.state;state.plan='Plus';f.runtime.store.save(workspaceId,state);state.projects.push({...extraProject,id:'plus-4'});state.libraries.push({...state.libraries[0],id:'plus-library'});assert.equal((await save(state)).status,200);
  const status=await f.request('/api/account/status');assert.deepEqual(status.data.limits,{projects:null,libraries:null,savedAssets:null,cleanExports:true});
});

test('public exports use the owner plan for watermark entitlement',async t=>{
  const f=await fixture(t);const state=await bootstrap(f);const boot=await f.request('/api/bootstrap');
  const response=await f.request('/api/share',{method:'POST',body:json({kind:'board',projectId:state.projects[0].id,resourceId:state.projects[0].boards[0].id,access:'view'})});assert.equal(response.status,201);
  const free=await f.request(`/api/share/${response.data.token}`,{headers:{cookie:''}});assert.equal(free.data.watermark,true);assert.equal(free.data.cleanExports,false);
  state.plan='Plus';f.runtime.store.save(boot.data.workspaceId,state);
  const paid=await f.request(`/api/share/${response.data.token}`,{headers:{cookie:''}});assert.equal(paid.data.watermark,false);assert.equal(paid.data.cleanExports,true);
});

test('verified designers have unlimited personal libraries while paid sharing and other Free quotas stay enforced',async t=>{
  const f=await fixture(t);let state=await bootstrap(f);const boot=await f.request('/api/bootstrap');state.profile.verified=true;f.runtime.store.save(boot.data.workspaceId,state);
  state.libraries.push({id:'verified-second',name:'Second library',productIds:[],members:[],shared:false},{id:'verified-third',name:'Third library',productIds:[],members:[],shared:false});
  const saved=await f.request('/api/workspace',{method:'PUT',body:json({state,baseRevision:state.revision})});assert.equal(saved.status,200);state=saved.data.state;
  const account=await f.request('/api/account/status');assert.equal(account.data.limits.libraries,null);assert.equal(account.data.limits.projects,1);assert.equal(account.data.limits.savedAssets,30);assert.equal(account.data.limits.cleanExports,false);
  assert.equal((await f.request(`/api/collaboration/libraries/${state.libraries[0].id}/links`,{method:'POST',body:json({access:'view'})})).status,402);
  state.projects.push({...state.projects[0],id:'too-many-projects'});assert.equal((await f.request('/api/workspace',{method:'PUT',body:json({state,baseRevision:state.revision})})).status,402);
});

async function pinterestFixture(t:TestContext){
  let current=new Date();let tokenCalls=0;let refreshCalls=0;const observed:string[]=[];
  const accessToken=randomBytes(32).toString('hex'),refreshToken=randomBytes(32).toString('hex'),renewedToken=randomBytes(32).toString('hex');
  const pins=[{id:'1001',title:'Textile',description:'Saved textile',link:'https://example.test/textile',media:{images:{'600x':{url:'https://images.example.test/1.jpg',width:600,height:400}}}},{id:'1002',title:'Stone',description:'Saved stone',link:'javascript:bad',media:{images:{'600x':{url:'https://images.example.test/2.jpg',width:600,height:600}}}}];
  const provider=(async(input:unknown,init?:RequestInit)=>{
    const url=new URL(String(input));observed.push(`${url.pathname}${url.search}`);
    if(url.pathname==='/v5/oauth/token'){
      const form=new URLSearchParams(String(init?.body));tokenCalls++;
      if(form.get('grant_type')==='refresh_token'){refreshCalls++;assert.ok(form.get('refresh_token')===refreshToken);return Response.json({access_token:renewedToken,expires_in:3600,scope:'boards:read,pins:read'});}
      assert.equal(form.get('grant_type'),'authorization_code');return Response.json({access_token:accessToken,refresh_token:refreshToken,expires_in:3600,scope:'boards:read,pins:read'});
    }
    const authorization=new Headers(init?.headers).get('Authorization');assert.ok(authorization===`Bearer ${refreshCalls?renewedToken:accessToken}`,'Provider calls must use the server-held access token');
    if(url.pathname==='/v5/boards')return Response.json({items:[{id:'11',name:'Materials',description:'References',privacy:'PUBLIC',pin_count:2}],bookmark:url.searchParams.has('bookmark')?null:'next-page'});
    if(url.pathname==='/v5/boards/11/pins')return Response.json({items:[pins[url.searchParams.has('bookmark')?1:0]],bookmark:url.searchParams.has('bookmark')?null:'pins-page-2'});
    return Response.json({error:'Unknown route'},{status:404});
  }) as typeof fetch;
  const f=await fixture(t,{env:{PINTEREST_CLIENT_ID:'test-client',PINTEREST_CLIENT_SECRET:'test-secret'},fetchImpl:provider,now:()=>current});
  const account=await signup(f,'pinterest@example.test');
  async function start(){const response=await f.request('/api/integrations/pinterest/connect',{method:'POST',body:'{}'});assert.equal(response.status,200);const url=new URL(response.data.url);assert.equal(url.origin,'https://www.pinterest.com');assert.equal(url.searchParams.get('scope'),'boards:read,pins:read');return url.searchParams.get('state')!;}
  async function finish(state:string,headers?:HeadersInit){return f.request(`/api/integrations/pinterest/callback?state=${state}&code=authorized`,{headers});}
  return{f,account,start,finish,pins,observed,get tokenCalls(){return tokenCalls;},get refreshCalls(){return refreshCalls;},setNow:(date:Date)=>{current=date;},hasSecret:(value:string)=>value.includes(accessToken)||value.includes(refreshToken)||value.includes(renewedToken)};
}

test('Pinterest OAuth is account-bound, single-use, expiring and stores only encrypted credentials',async t=>{
  const p=await pinterestFixture(t);const state=await p.start();const firstCookie=p.f.cookies();
  await signup(p.f,'different@example.test');
  assert.equal((await p.finish(state)).status,403);assert.equal(p.tokenCalls,0);
  const connected=await p.finish(state,{cookie:firstCookie});assert.equal(connected.status,200);assert.ok(!p.hasSecret(Buffer.from(connected.data).toString()));
  assert.equal((await p.finish(state,{cookie:firstCookie})).status,403);assert.equal(p.tokenCalls,1);
  const row=p.f.runtime.db.prepare('SELECT credentials FROM pinterest_connections WHERE workspace_id=?').get(p.account.workspaceId) as {credentials:string};assert.ok(row.credentials&&!p.hasSecret(row.credentials),'Credentials must be encrypted at rest');
  const status=await p.f.request('/api/integrations/pinterest/status',{headers:{cookie:firstCookie}});assert.equal(status.data.connected,true);assert.ok(!p.hasSecret(json(status.data)));assert.ok(!('credentials' in status.data));
  const pending=await p.start();p.setNow(new Date(Date.now()+11*60*1000));assert.equal((await p.finish(pending)).status,403);
});

test('Pinterest reads paginate, refresh server credentials, import selected pins and deduplicate durably',async t=>{
  const p=await pinterestFixture(t);assert.equal((await p.finish(await p.start())).status,200);
  let boards=await p.f.request('/api/integrations/pinterest/boards');assert.equal(boards.status,200);assert.equal(boards.data.items[0].name,'Materials');assert.equal(boards.data.bookmark,'next-page');
  boards=await p.f.request('/api/integrations/pinterest/boards?bookmark=next-page');assert.equal(boards.data.bookmark,null);
  const pins=await p.f.request('/api/integrations/pinterest/boards/11/pins?bookmark=pins-page-2');assert.equal(pins.data.items[0].link,'');assert.equal(pins.data.items[0].id,'1002');
  p.setNow(new Date(Date.now()+3600*1000));assert.equal((await p.f.request('/api/integrations/pinterest/boards')).status,200);assert.equal(p.refreshCalls,1);
  const body=json({boardId:'11',pinIds:['1002']});const imported=await p.f.request('/api/integrations/pinterest/import',{method:'POST',body});assert.equal(imported.status,200);assert.equal(imported.data.imported,1);assert.equal(imported.data.duplicates,0);assert.equal(imported.data.state.products.find((product:Product)=>product.id==='pinterest-1002').sourceUrl,'https://www.pinterest.com/pin/1002/');
  await p.f.restart();const again=await p.f.request('/api/integrations/pinterest/import',{method:'POST',body});assert.equal(again.data.imported,0);assert.equal(again.data.duplicates,1);
  assert.equal((await p.f.request('/api/integrations/pinterest/import',{method:'POST',body:json({boardId:'11',pinIds:['not-a-pin']})})).status,400);
  assert.equal((await p.f.request('/api/integrations/pinterest/import',{method:'POST',body:json({boardId:'11',pinIds:['9999']})})).status,400);
  assert.equal((await p.f.request('/api/integrations/pinterest/disconnect',{method:'DELETE'})).status,200);assert.equal((await p.f.request('/api/integrations/pinterest/status')).data.connected,false);assert.equal((await p.f.request('/api/integrations/pinterest/boards')).status,401);
});

test('Pinterest imports enforce saved-product quota with no partial state or import records',async t=>{
  const p=await pinterestFixture(t);assert.equal((await p.finish(await p.start())).status,200);
  const {state}=p.f.runtime.store.get(p.account.workspaceId);state.products.push(...Array.from({length:29},(_,index)=>({...privateProduct,id:`quota-${index}`})));p.f.runtime.store.save(p.account.workspaceId,state);
  const response=await p.f.request('/api/integrations/pinterest/import',{method:'POST',body:json({boardId:'11'})});assert.equal(response.status,402);
  const saved=p.f.runtime.store.get(p.account.workspaceId).state;assert.ok(!saved.products.some(product=>product.id.startsWith('pinterest-')));assert.equal(saved.revision,state.revision);
  const records=p.f.runtime.db.prepare('SELECT count(*) AS total FROM pinterest_imports WHERE workspace_id=?').get(p.account.workspaceId) as {total:number};assert.equal(records.total,0);
});

test('catalog file enrichment reaches existing workspaces while preserving local edits, selections and custom assets',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'monogram-catalog-')),catalogPath=path.join(directory,'catalog.json'),db=new Database(':memory:');
  const first={...product,specs:{Brand:'Test brand'}},second={...product,id:'customized-public'};
  writeFileSync(catalogPath,json([first,second]));const store=new Store(db,[first,second],()=>new Date('2026-10-17T00:00:00Z'),'UTC',catalogPath);
  try{
    let {state}=store.get('owner');state.products[0].name='My edited name';state.products[0].model='/uploads/my-model.glb';state.products[0].favorite=true;state.favorites=[first.id];state.libraries[0].productIds=[first.id];state.projects[0].drawer=[first.id];state.products[1].custom=true;state.products[1].name='Entirely custom asset';store.save('owner',state);
    const enriched={...first,name:'Official corrected name',description:'Official details',images:['/assets/front.webp','/assets/back.webp'],variantIds:['variant-1'],model:'/assets/official.glb',modelSize:[1,2,3],sampleKind:'model',material:{...defaultMaterial(),roughness:0.4,ormMap:'/assets/orm.webp',normalScale:1.5},specs:{Brand:'Test brand',Width:'100 mm'}};
    writeFileSync(catalogPath,json([enriched,{...second,model:'/assets/second.glb'}]));state=store.get('owner').state;
    assert.equal(state.revision,1);assert.equal(state.products[0].name,'My edited name');assert.equal(state.products[0].model,'/uploads/my-model.glb');assert.equal(state.products[0].description,'Official details');assert.deepEqual(state.products[0].images,enriched.images);assert.deepEqual(state.products[0].modelSize,[1,2,3]);assert.equal(state.products[0].specs.Width,'100 mm');assert.equal(state.products[0].favorite,true);
    assert.deepEqual(state.favorites,[first.id]);assert.deepEqual(state.libraries[0].productIds,[first.id]);assert.deepEqual(state.projects[0].drawer,[first.id]);assert.equal(state.products[1].name,'Entirely custom asset');assert.equal(state.products[1].model,undefined);
    state.products[0].material!.roughness=0.9;store.save('owner',state);
    writeFileSync(catalogPath,json([{...enriched,modelSize:[2,3,4],material:{...enriched.material,roughness:0.2,metalness:0.5}},second]));state=store.get('owner').state;assert.equal(state.revision,2);assert.equal(state.products[0].material!.roughness,0.9);assert.equal(state.products[0].material!.metalness,0.5);assert.deepEqual(state.products[0].modelSize,[2,3,4]);
    assert.equal(store.get('owner').state.revision,2);writeFileSync(catalogPath,'{"incomplete":');assert.equal(store.get('owner').state.revision,2);
  }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});

test('legacy catalog synchronization fills missing metadata conservatively and never recreates a known deleted product',()=>{
  const db=new Database(':memory:'),store=new Store(db,[product,{...product,id:'deleted-product'}],()=>new Date('2026-10-17T00:00:00Z'));
  try{
    let {state}=store.get('legacy');state.products[0].image='/uploads/local-photo.png';state.products[0].description='Local description';state.products[0].specs={Finish:'Local finish'};store.save('legacy',state);db.prepare('DELETE FROM workspace_catalog WHERE workspace_id=?').run('legacy');
    store.products=[{...product,image:'/assets/new-official.webp',description:'New official description',model:'/assets/source.glb',images:['/assets/gallery.webp'],specs:{Finish:'Source finish',Width:'100 mm'}},{...product,id:'deleted-product'}];
    state=store.get('legacy').state;assert.equal(state.products[0].image,'/uploads/local-photo.png');assert.equal(state.products[0].description,'Local description');assert.equal(state.products[0].model,'/assets/source.glb');assert.equal(state.products[0].specs.Finish,'Local finish');assert.equal(state.products[0].specs.Width,'100 mm');assert.equal(state.revision,1);
    state.products=state.products.filter(product=>product.id!=='deleted-product');store.save('legacy',state);
    store.products=[...store.products.map(product=>({...product,brand:'Updated official brand'})),{...product,id:'new-catalog-product'}];state=store.get('legacy').state;
    assert.ok(!state.products.some(product=>product.id==='deleted-product'));assert.ok(state.products.some(product=>product.id==='new-catalog-product'));assert.equal(store.get('legacy').state.revision,state.revision);
  }finally{db.close();}
});
