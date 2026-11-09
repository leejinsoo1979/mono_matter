import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import {randomBytes} from 'node:crypto';
import {createApp} from '../server/app.ts';
import type {WorkspaceState} from '../shared/types.ts';

async function fixture(t:TestContext){
  const directory=mkdtempSync(path.join(tmpdir(),'monogram-profiles-'));const runtime=await createApp({dataDir:directory,catalog:[],env:{APP_URL:'http://127.0.0.1:5173',BETTER_AUTH_URL:'http://127.0.0.1:5173',BETTER_AUTH_SECRET:randomBytes(48).toString('hex')}});
  const server=runtime.app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async()=>{runtime.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});});
  const call=async(route:string,{cookie='',method='GET',body}:{cookie?:string;method?:string;body?:unknown}={})=>{
    const response=await fetch(`${base}${route}`,{method,headers:{...(cookie?{cookie}:{}),...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
    return{status:response.status,data:response.headers.get('Content-Type')?.includes('application/json')?await response.json():Buffer.from(await response.arrayBuffer()),headers:response.headers};
  };
  const visitor=async()=>{const boot=await call('/api/bootstrap');assert.equal(boot.status,200);return{cookie:boot.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '),workspaceId:boot.data.workspaceId as string,state:boot.data.state as WorkspaceState};};
  const save=async(client:Awaited<ReturnType<typeof visitor>>,state:WorkspaceState)=>call('/api/workspace',{cookie:client.cookie,method:'PUT',body:{state,baseRevision:state.revision,workspaceId:client.workspaceId}});
  return{runtime,call,visitor,save};
}

test('public profiles expose only the approved profile fields and disappear immediately when made private',async t=>{
  const f=await fixture(t),owner=await f.visitor();assert.equal((await f.call('/api/profiles/designer')).status,404);
  owner.state.profile={...owner.state.profile,name:'Public designer',username:'publicdesigner',country:'Korea',bio:'Public studio biography',email:'private@example.test',public:true,verified:true};owner.state.projects[0].name='PRIVATE PROJECT';owner.state.settings.privateSecret='PRIVATE SETTINGS';
  Object.assign(owner.state.profile,{privateNote:'PRIVATE NOTE'});
  const saved=await f.save(owner,owner.state);assert.equal(saved.status,200);assert.equal(saved.data.state.profile.verified,false);
  const response=await f.call('/api/profiles/publicdesigner');assert.equal(response.status,200);assert.deepEqual(Object.keys(response.data).sort(),['name','username','country','bio','avatar','verified'].sort());assert.equal(response.data.name,'Public designer');assert.equal(response.data.verified,false);
  const serialized=JSON.stringify(response.data);for(const privateValue of ['private@example.test','PRIVATE PROJECT','PRIVATE SETTINGS','PRIVATE NOTE','settings','projects','members','requests','workspaceId'])assert.ok(!serialized.includes(privateValue));
  assert.equal((await f.call('/api/profiles/UNKNOWN')).status,404);assert.equal((await f.call('/api/profiles/unknown')).status,404);
  const state=saved.data.state as WorkspaceState;state.profile.public=false;assert.equal((await f.save(owner,state)).status,200);assert.equal((await f.call('/api/profiles/publicdesigner')).status,404);
});

test('public usernames are unique, lowercase and transactional while unchanged invalid private usernames remain editable',async t=>{
  const f=await fixture(t),first=await f.visitor(),second=await f.visitor();
  first.state.profile.username='uniquedesigner';first.state.profile.public=true;const published=await f.save(first,first.state);assert.equal(published.status,200);
  second.state.profile.username='uniquedesigner';let result=await f.save(second,second.state);assert.equal(result.status,200,'Private duplicate names are allowed');
  let next=result.data.state as WorkspaceState;next.profile.public=true;assert.equal((await f.save(second,next)).status,409);
  const untouched=await f.call('/api/workspace',{cookie:second.cookie});assert.equal(untouched.data.state.profile.public,false);assert.equal(untouched.data.state.revision,next.revision);
  next=untouched.data.state;next.profile.username='Uppercase';assert.equal((await f.save(second,next)).status,400);
  next.profile.username='xx';assert.equal((await f.save(second,next)).status,400);
  const legacy=untouched.data.state as WorkspaceState;legacy.profile.username='Legacy name!';f.runtime.store.save(second.workspaceId,legacy);legacy.profile.bio='An unrelated edit';result=await f.save(second,legacy);assert.equal(result.status,200);
  next=result.data.state;next.profile.public=true;assert.equal((await f.save(second,next)).status,400);
  const firstState=published.data.state as WorkspaceState;firstState.profile.public=false;assert.equal((await f.save(first,firstState)).status,200);
  next.profile.username='uniquedesigner';result=await f.save(second,next);assert.equal(result.status,200);assert.equal((await f.call('/api/profiles/uniquedesigner')).data.bio,'An unrelated edit');
});

test('published avatars grant access only to the exact owner image and lose access with profile privacy',async t=>{
  const f=await fixture(t),owner=await f.visitor(),other=await f.visitor();
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
  const upload=async(cookie:string)=>{const form=new FormData();form.set('file',new Blob([png],{type:'image/png'}),'avatar.png');const result=await f.call('/api/upload',{cookie,method:'POST',body:form});assert.equal(result.status,201);return result.data.url as string;};
  const own=await upload(owner.cookie),unlisted=await upload(owner.cookie),foreign=await upload(other.cookie);
  owner.state.profile={...owner.state.profile,username:'avatarowner',public:true,avatar:own};let saved=await f.save(owner,owner.state);assert.equal(saved.status,200);
  const profile=await f.call('/api/profiles/avatarowner');assert.match(profile.data.avatar,/^\/api\/profiles\/avatarowner\/avatar\//);const image=await f.call(profile.data.avatar);assert.equal(image.status,200);assert.ok(image.data.equals(png));
  assert.equal((await f.call(`/api/profiles/avatarowner/avatar/${unlisted.split('/').at(-1)}`)).status,404);assert.equal((await f.call(`/api/profiles/avatarowner/avatar/${foreign.split('/').at(-1)}`)).status,404);
  let state=saved.data.state as WorkspaceState;state.profile.avatar=foreign;saved=await f.save(owner,state);assert.equal(saved.status,200);assert.equal((await f.call('/api/profiles/avatarowner')).data.avatar,'');assert.equal((await f.call(profile.data.avatar)).status,404);
  state=saved.data.state;state.profile.avatar=own;state.profile.public=false;assert.equal((await f.save(owner,state)).status,200);assert.equal((await f.call(profile.data.avatar)).status,404);
});
