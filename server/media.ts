import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import type {Product,WorkspaceState,Project,Library} from '../shared/types.ts';
import {HttpError,type Store} from './store.ts';

const filenamePattern=/^[a-f0-9]+\.(png|jpg|webp|gif|pdf|glb)$/;
const contains=(value:unknown,url:string):boolean=>value===url||(Array.isArray(value)&&value.some(item=>contains(item,url)))||(!!value&&typeof value==='object'&&Object.values(value).some(item=>contains(item,url)));
const referencedIds=(project:Project)=>[...new Set([...project.drawer,...project.boards.flatMap(board=>board.items.flatMap(item=>item.productId?[item.productId]:[])),...project.schedules.flatMap(schedule=>schedule.rows.flatMap(row=>row.productId?[row.productId]:[]))])];
type Link={workspace_id:string;resource_id:string;kind:string;product_ids:string;project_id?:string};

/** Opaque upload URLs are readable by an owner or while present in a live scoped share. */
export function publiclyReferencedUpload(store:Store,workspaceId:string,filename:string){
  if(!filenamePattern.test(filename))return false;
  const row=store.db.prepare('SELECT state FROM workspaces WHERE id=?').get(workspaceId) as {state:string}|undefined;if(!row)return false;
  const state=JSON.parse(row.state) as WorkspaceState,url=`/uploads/${filename}`;
  for(const share of store.db.prepare('SELECT project_id,resource_id,kind,product_ids FROM shares WHERE workspace_id=?').all(workspaceId) as Link[]){
    const project=state.projects.find(item=>item.id===share.project_id&&!item.archived);if(!project)continue;
    const resource=share.kind==='board'?project.boards.find(item=>item.id===share.resource_id):project.schedules.find(item=>item.id===share.resource_id);if(!resource)continue;
    const allowed=new Set(JSON.parse(share.product_ids) as string[]),ids=share.kind==='board'?project.boards.find(item=>item.id===share.resource_id)!.items.flatMap(item=>item.productId?[item.productId]:[]):project.schedules.find(item=>item.id===share.resource_id)!.rows.flatMap(item=>item.productId?[item.productId]:[]);
    const {shareToken:_token,...publicResource}=resource;
    if(contains(publicResource,url)||state.products.some(product=>allowed.has(product.id)&&ids.includes(product.id)&&contains(product,url)))return true;
  }
  const exists=store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='collaboration_links'").get();if(!exists)return false;
  for(const link of store.db.prepare('SELECT resource_id,kind,product_ids FROM collaboration_links WHERE workspace_id=?').all(workspaceId) as Link[]){
    const allowed=new Set(JSON.parse(link.product_ids) as string[]);
    if(link.kind==='project'){
      const project=state.projects.find(item=>item.id===link.resource_id&&!item.archived);if(!project)continue;
      const publicProject={...project,members:[],drawer:project.drawer.filter(id=>allowed.has(id)),boards:project.boards.map(({shareToken:_token,...board})=>({...board,items:board.items.filter(item=>!item.productId||allowed.has(item.productId))})),schedules:project.schedules.map(({shareToken:_token,...schedule})=>({...schedule,rows:schedule.rows.filter(row=>!row.productId||allowed.has(row.productId))}))};
      const ids=new Set(referencedIds(publicProject));if(contains(publicProject,url)||state.products.some(product=>allowed.has(product.id)&&ids.has(product.id)&&contains(product,url)))return true;
    }else if(link.kind==='library'){
      const library=state.libraries.find(item=>item.id===link.resource_id) as Library|undefined;if(!library)continue;
      // Library snapshots include the fixed allowed products so an editor can restore membership.
      if(state.products.some(product=>allowed.has(product.id)&&contains(product,url)))return true;
    }
  }
  return false;
}

/** Prepare actual independent file copies; commit metadata inside the caller's transaction. */
export function prepareProductUploadCopies(store:Store,sourceWorkspaceId:string,targetWorkspaceId:string,products:Product[],uploadDir:string){
  const written:string[]=[],copies:{filename:string;name:string;mime:string;size:number}[]=[],replacements=new Map<string,string>();
  const cleanup=()=>{for(const filename of written)rmSync(path.join(uploadDir,filename),{force:true});};
  const usage=store.db.prepare('SELECT COALESCE(SUM(size),0) AS total FROM uploads WHERE workspace_id=?').get(targetWorkspaceId) as {total:number};let total=usage.total;
  const rewrite=(value:unknown):unknown=>{
    if(typeof value==='string'&&value.startsWith('/uploads/')){
      const oldName=value.slice('/uploads/'.length);if(!filenamePattern.test(oldName))throw new HttpError(400,'A shared upload reference is invalid.');
      if(replacements.has(value))return replacements.get(value)!;
      const source=store.db.prepare('SELECT workspace_id,name,mime,size FROM uploads WHERE filename=?').get(oldName) as {workspace_id:string;name:string;mime:string;size:number}|undefined;
      if(!source||(source.workspace_id!==sourceWorkspaceId&&source.workspace_id!==targetWorkspaceId&&!publiclyReferencedUpload(store,source.workspace_id,oldName)))throw new HttpError(403,'A shared file is no longer available to copy.');
      let bytes:Buffer;try{bytes=readFileSync(path.join(uploadDir,oldName));}catch{throw new HttpError(404,'A shared file is no longer available to copy.');}
      total+=bytes.length;if(total>200*1024*1024)throw new HttpError(413,'Workspace upload storage limit reached.');
      const filename=`${randomBytes(24).toString('hex')}${path.extname(oldName)}`;written.push(filename);writeFileSync(path.join(uploadDir,filename),bytes,{mode:0o600});copies.push({filename,name:source.name,mime:source.mime,size:bytes.length});const url=`/uploads/${filename}`;replacements.set(value,url);return url;
    }
    if(Array.isArray(value))return value.map(rewrite);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,rewrite(item)]));
    return value;
  };
  try{return{products:products.map(product=>rewrite(product) as Product),commit:()=>{const insert=store.db.prepare('INSERT INTO uploads(filename,workspace_id,name,mime,size) VALUES(?,?,?,?,?)');for(const copy of copies)insert.run(copy.filename,targetWorkspaceId,copy.name,copy.mime,copy.size);},cleanup};}catch(error){cleanup();throw error;}
}
