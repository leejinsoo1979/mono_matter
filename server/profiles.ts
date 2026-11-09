import type {Express} from 'express';
import path from 'node:path';
import type {Profile,WorkspaceState} from '../shared/types.ts';
import {HttpError,type Store} from './store.ts';

const username=(value:unknown):value is string=>typeof value==='string'&&/^[a-z0-9]{3,30}$/.test(value);
export function validateProfileChange(store:Store,workspaceId:string,previous:Profile,next:Profile){
  if((next.public||next.username!==previous.username)&&!username(next.username))throw new HttpError(400,'Username must contain 3–30 lowercase letters or numbers.');
  if(next.public&&store.db.prepare("SELECT id FROM workspaces WHERE id<>? AND json_extract(state,'$.profile.public')=1 AND json_extract(state,'$.profile.username')=? LIMIT 1").get(workspaceId,next.username))throw new HttpError(409,'This public username is already in use. Choose another username.');
}

/** Public pages expose a strict profile whitelist, with no workspace or account metadata. */
export function registerProfileRoutes(app:Express,{store,uploadDir}:{store:Store;uploadDir:string}){
  const find=(value:string)=>{
    if(!username(value))throw new HttpError(404,'Public profile not found.');
    const rows=store.db.prepare("SELECT id,state FROM workspaces WHERE json_extract(state,'$.profile.public')=1 AND json_extract(state,'$.profile.username')=? LIMIT 2").all(value) as {id:string;state:string}[];
    if(rows.length!==1)throw new HttpError(404,'Public profile not found.');
    const row=rows[0],profile=(JSON.parse(row.state) as WorkspaceState).profile;return{workspaceId:row.id,profile};
  };
  const ownsAvatar=(workspaceId:string,avatar:string,filename:string)=>{
    if(avatar!==`/uploads/${filename}`||!/^[a-zA-Z0-9._-]+$/.test(filename))return false;
    const row=store.db.prepare('SELECT workspace_id,mime FROM uploads WHERE filename=?').get(filename) as {workspace_id:string;mime:string}|undefined;
    return row?.workspace_id===workspaceId&&['image/png','image/jpeg','image/webp','image/gif'].includes(row.mime);
  };
  app.get('/api/profiles/:username/avatar/:filename',(req,res)=>{
    const value=String(req.params.username),filename=String(req.params.filename),{workspaceId,profile}=find(value);
    if(!ownsAvatar(workspaceId,profile.avatar,filename))throw new HttpError(404,'Public avatar not found.');
    res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");res.sendFile(path.resolve(uploadDir,filename));
  });
  app.get('/api/profiles/:username',(req,res)=>{
    const value=String(req.params.username),{workspaceId,profile}=find(value);let avatar=profile.avatar;
    if(avatar.startsWith('/uploads/')){const filename=avatar.slice('/uploads/'.length);avatar=ownsAvatar(workspaceId,avatar,filename)?`/api/profiles/${value}/avatar/${filename}`:'';}
    res.json({name:profile.name,username:profile.username,country:profile.country,bio:profile.bio,avatar,verified:profile.verified});
  });
}
