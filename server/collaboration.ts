import type {Express,Request,Response,RequestHandler} from 'express';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {Board,Library,Product,Project,Schedule,WorkspaceState} from '../shared/types.ts';
import {planLimits} from '../shared/entitlements.ts';
import {HttpError,Store,validateState,validBoard,validSchedule} from './store.ts';
import {prepareProductUploadCopies} from './media.ts';

type Context={workspaceId:string;user:{email:string;visitor:boolean}};
type Dependencies={store:Store;requireContext:RequestHandler;getContext:(res:Response)=>Context;broadcast:(workspaceId:string,state:WorkspaceState)=>void;now:()=>Date;appUrl:string;uploadDir?:string};
type Kind='project'|'library';
type Link={id:string;token_hash:string;workspace_id:string;resource_id:string;kind:Kind;access:'view'|'edit';product_ids:string;label:string;created_at:string};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown,max=1000):value is string=>typeof value==='string'&&value.length<=max;
const productReferences=(project:Project)=>[...new Set([...project.drawer,...project.boards.flatMap(board=>board.items.flatMap(item=>item.productId?[item.productId]:[])),...project.schedules.flatMap(schedule=>schedule.rows.flatMap(row=>row.productId?[row.productId]:[]))])];
const publicBoard=(board:Board):Board=>({id:board.id,name:board.name,items:board.items,settings:board.settings,updatedAt:board.updatedAt});
const publicSchedule=(schedule:Schedule):Schedule=>({id:schedule.id,name:schedule.name,columns:schedule.columns,rows:schedule.rows,groups:schedule.groups,updatedAt:schedule.updatedAt,...(schedule.logo?{logo:schedule.logo}:{})});
const publicProject=(project:Project):Project=>({id:project.id,name:project.name,description:project.description,cover:project.cover,drawer:project.drawer,members:[],boards:project.boards.map(publicBoard),schedules:project.schedules.map(publicSchedule),updatedAt:project.updatedAt});
const publicLibrary=(library:Library):Library=>({id:library.id,name:library.name,productIds:library.productIds,shared:library.shared,members:[]});
const metadata=(link:Link)=>({id:link.id,kind:link.kind,access:link.access,label:link.label,date:link.created_at});
const assertAllowedKeys=(value:Record<string,unknown>,keys:string[])=>{if(Object.keys(value).some(key=>!keys.includes(key)))throw new HttpError(400,'Unsupported shared data fields.');};

/** Bearer collaboration links are scoped to one resource and a fixed product allowlist. */
export function registerCollaborationRoutes(app:Express,{store,requireContext,getContext,broadcast,now,appUrl,uploadDir}:Dependencies){
  const db=store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS collaboration_links(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,workspace_id TEXT NOT NULL,resource_id TEXT NOT NULL,kind TEXT NOT NULL,access TEXT NOT NULL,product_ids TEXT NOT NULL,label TEXT NOT NULL,created_at TEXT NOT NULL);CREATE INDEX IF NOT EXISTS collaboration_resource ON collaboration_links(workspace_id,kind,resource_id);`);
  const findLink=(token:string)=>{if(!/^[a-f0-9]{64}$/.test(token))throw new HttpError(404,'Collaboration link not found.');const link=db.prepare('SELECT * FROM collaboration_links WHERE token_hash=?').get(hash(token)) as Link|undefined;if(!link)throw new HttpError(404,'This collaboration link has been revoked or is unavailable.');return link;};
  const resourceFor=(link:Link)=>{
    const {state}=store.get(link.workspace_id);
    const resource=link.kind==='project'?state.projects.find(project=>project.id===link.resource_id&&!project.archived):state.libraries.find(library=>library.id===link.resource_id);
    if(!resource)throw new HttpError(404,'The shared resource is no longer available.');
    return {state,resource};
  };
  const snapshot=(link:Link)=>{
    const {state,resource}=resourceFor(link),allowed=new Set(JSON.parse(link.product_ids) as string[]);
    const ids=new Set((link.kind==='project'?productReferences(resource as Project):(resource as Library).productIds).filter(id=>allowed.has(id)));
    if(link.kind==='project'){
      const project=publicProject(resource as Project);project.drawer=project.drawer.filter(id=>ids.has(id));
      for(const board of project.boards)board.items=board.items.filter(item=>!item.productId||ids.has(item.productId));
      for(const schedule of project.schedules)schedule.rows=schedule.rows.filter(row=>!row.productId||ids.has(row.productId));
      return {kind:link.kind,access:link.access,revision:state.revision,project,products:state.products.filter(product=>ids.has(product.id)),watermark:!planLimits(state.plan).cleanExports};
    }
    const library=publicLibrary(resource as Library);library.productIds=library.productIds.filter(id=>ids.has(id));
    return {kind:link.kind,access:link.access,revision:state.revision,library,products:state.products.filter(product=>allowed.has(product.id)),watermark:!planLimits(state.plan).cleanExports};
  };
  for(const kind of ['project','library'] as const){
    const base=`/api/collaboration/${kind==='project'?'projects':'libraries'}/:id/links`;
    app.get(base,requireContext,(req,res)=>{
      const ctx=getContext(res),{state}=store.get(ctx.workspaceId);
      const exists=kind==='project'?state.projects.some(project=>project.id===req.params.id):state.libraries.some(library=>library.id===req.params.id);
      if(!exists)throw new HttpError(404,`${kind==='project'?'Project':'Library'} not found.`);
      res.json({links:(db.prepare('SELECT * FROM collaboration_links WHERE workspace_id=? AND resource_id=? AND kind=? ORDER BY created_at DESC').all(ctx.workspaceId,req.params.id,kind) as Link[]).map(metadata)});
    });
    app.post(base,requireContext,(req,res)=>{
      if(!object(req.body)||!['view','edit'].includes(String(req.body.access))||(req.body.label!==undefined&&!text(req.body.label,320)))throw new HttpError(400,'Choose view or edit access and a valid label.');
      assertAllowedKeys(req.body,['access','label']);
      const ctx=getContext(res),{state}=store.get(ctx.workspaceId);
      const resource=kind==='project'?state.projects.find(project=>project.id===req.params.id&&!project.archived):state.libraries.find(library=>library.id===req.params.id);
      if(!resource)throw new HttpError(404,`${kind==='project'?'Project':'Library'} not found.`);
      if(kind==='library'&&!planLimits(state.plan).cleanExports)throw new HttpError(402,'Shared material libraries are included with Plus and Studio.');
      const ids=kind==='project'?productReferences(resource as Project):(resource as Library).productIds;
      const token=randomBytes(32).toString('hex'),link:Link={id:randomUUID(),token_hash:hash(token),workspace_id:ctx.workspaceId,resource_id:String(req.params.id),kind,access:req.body.access as Link['access'],product_ids:JSON.stringify(ids),label:typeof req.body.label==='string'?req.body.label.trim():'',created_at:now().toISOString()};
      const count=db.prepare('SELECT COUNT(*) AS count FROM collaboration_links WHERE workspace_id=? AND resource_id=? AND kind=?').get(ctx.workspaceId,req.params.id,kind) as {count:number};
      if(count.count>=1000)throw new HttpError(400,'Revoke an unused link before creating another.');
      db.prepare('INSERT INTO collaboration_links(id,token_hash,workspace_id,resource_id,kind,access,product_ids,label,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(link.id,link.token_hash,link.workspace_id,link.resource_id,link.kind,link.access,link.product_ids,link.label,link.created_at);
      const result=store.mutate(ctx.workspaceId,draft=>{if(kind==='library')draft.libraries.find(library=>library.id===link.resource_id)!.shared=true;});
      broadcast(ctx.workspaceId,result.state);
      res.status(201).json({link:metadata(link),token,url:`${appUrl}/collaborate/${token}`,state:result.state});
    });
  }
  app.delete('/api/collaboration/links/:id',requireContext,(req,res)=>{
    const ctx=getContext(res),link=db.prepare('SELECT * FROM collaboration_links WHERE id=?').get(req.params.id) as Link|undefined;
    if(!link)throw new HttpError(404,'Collaboration link not found.');if(link.workspace_id!==ctx.workspaceId)throw new HttpError(403,'Only the owner can revoke this link.');
    db.prepare('DELETE FROM collaboration_links WHERE id=?').run(link.id);
    const result=store.mutate(ctx.workspaceId,state=>{if(link.kind==='library'){const library=state.libraries.find(item=>item.id===link.resource_id);if(library)library.shared=!!db.prepare('SELECT id FROM collaboration_links WHERE workspace_id=? AND resource_id=? AND kind=?').get(ctx.workspaceId,link.resource_id,'library');}});
    broadcast(ctx.workspaceId,result.state);res.json({ok:true,state:result.state});
  });
  app.get('/api/collaboration/share/:token',(req,res)=>res.json(snapshot(findLink(String(req.params.token)))));
  app.put('/api/collaboration/share/:token',(req,res)=>{
    const link=findLink(String(req.params.token));if(link.access!=='edit')throw new HttpError(403,'This collaboration link allows viewing only.');
    if(!object(req.body)||!Number.isInteger(req.body.baseRevision))throw new HttpError(400,'A base revision is required.');
    assertAllowedKeys(req.body,link.kind==='project'?['baseRevision','project']:['baseRevision','library','products']);
    const allowed=new Set(JSON.parse(link.product_ids) as string[]);
    const result=store.mutate(link.workspace_id,state=>{
      if(req.body.baseRevision!==state.revision)throw new HttpError(409,'This shared workspace changed. Refresh and merge before saving.');
      if(link.kind==='project'){
        const current=state.projects.find(project=>project.id===link.resource_id&&!project.archived),input=req.body.project;
        if(!current)throw new HttpError(404,'Project not found.');
        if(!object(input)||input.id!==current.id||!Array.isArray(input.boards)||!Array.isArray(input.schedules)||!input.boards.every(validBoard)||!input.schedules.every(validSchedule)||!Array.isArray(input.drawer)||!input.drawer.every(id=>typeof id==='string'&&allowed.has(id))||!text(input.name,500)||!text(input.description,10000)||!text(input.cover,2_000_000))throw new HttpError(400,'Invalid shared project.');
        assertAllowedKeys(input,['id','name','description','cover','boards','schedules','drawer','members','archived','updatedAt']);
        const submitted={...current,boards:input.boards as Board[],schedules:input.schedules as Schedule[],drawer:input.drawer as string[]};
        if(productReferences(submitted).some(id=>!allowed.has(id)))throw new HttpError(403,'This link cannot access other private products.');
        const hidden=(id:string|undefined)=>!!id&&!allowed.has(id);
        for(const board of current.boards)if(!submitted.boards.some(item=>item.id===board.id)&&board.items.some(item=>hidden(item.productId)))throw new HttpError(403,'Ask the owner to remove a board containing products outside this link.');
        for(const schedule of current.schedules)if(!submitted.schedules.some(item=>item.id===schedule.id)&&schedule.rows.some(item=>hidden(item.productId)))throw new HttpError(403,'Ask the owner to remove a schedule containing products outside this link.');
        const boards=submitted.boards.map(board=>{const previous=current.boards.find(item=>item.id===board.id),privateItems=previous?.items.filter(item=>hidden(item.productId))||[];if(board.items.some(item=>privateItems.some(privateItem=>privateItem.id===item.id)))throw new HttpError(403,'A shared item identifier conflicts with a private item.');return {...publicBoard(board),items:[...board.items,...privateItems],shareToken:previous?.shareToken};});
        const schedules=submitted.schedules.map(schedule=>{const previous=current.schedules.find(item=>item.id===schedule.id),privateRows=previous?.rows.filter(item=>hidden(item.productId))||[];if(schedule.rows.some(row=>privateRows.some(privateRow=>privateRow.id===row.id)))throw new HttpError(403,'A shared row identifier conflicts with a private row.');const privateGroupIds=new Set(privateRows.map(row=>row.groupId));return {...publicSchedule(schedule),rows:[...schedule.rows,...privateRows],groups:[...schedule.groups,...(previous?.groups.filter(group=>privateGroupIds.has(group.id)&&!schedule.groups.some(item=>item.id===group.id))||[])],shareToken:previous?.shareToken};});
        const project={...current,name:input.name,description:input.description,cover:input.cover,boards,schedules,drawer:[...new Set([...submitted.drawer,...current.drawer.filter(id=>hidden(id))])],updatedAt:now().toISOString()};
        if(new Set(project.boards.map(board=>board.id)).size!==project.boards.length||new Set(project.schedules.map(schedule=>schedule.id)).size!==project.schedules.length)throw new HttpError(400,'Shared resource identifiers must be unique.');
        state.projects[state.projects.indexOf(current)]=project;
      }else{
        const current=state.libraries.find(library=>library.id===link.resource_id),input=req.body.library;
        if(!current)throw new HttpError(404,'Library not found.');
        if(!object(input)||input.id!==current.id||!text(input.name,500)||!Array.isArray(input.productIds)||input.productIds.length>20000||!input.productIds.every(id=>typeof id==='string'&&allowed.has(id)))throw new HttpError(403,'Only products included in this library link can be edited.');
        assertAllowedKeys(input,['id','name','productIds','members','shared']);
        current.name=input.name;current.productIds=[...new Set([...input.productIds,...current.productIds.filter(id=>!allowed.has(id))])] as string[];
        if(req.body.products!==undefined){
          if(!Array.isArray(req.body.products)||req.body.products.length>allowed.size)throw new HttpError(400,'Invalid shared products.');
          const seen=new Set<string>();
          for(const product of req.body.products){
            if(!object(product)||typeof product.id!=='string'||!allowed.has(product.id)||seen.has(product.id))throw new HttpError(403,'This link cannot edit other private products.');
            seen.add(product.id);assertAllowedKeys(product,['id','name','brand','category','type','image','color','price','description','specs','variants','texture','model','material','shape','sourceUrl','files','custom','favorite','images','variantIds','modelSize','sampleKind']);
            const index=state.products.findIndex(item=>item.id===product.id);if(index<0)throw new HttpError(404,'Product no longer available.');
            state.products[index]={...product,custom:state.products[index].custom} as Product;
          }
        }
      }
      validateState(state);
    });
    broadcast(link.workspace_id,result.state);res.json(snapshot(link));
  });
  app.post('/api/collaboration/share/:token/copy',requireContext,(req,res)=>{
    const link=findLink(String(req.params.token));if(link.kind!=='library')throw new HttpError(400,'Only a material library can be copied here.');
    const shared=snapshot(link),ctx=getContext(res),library=shared.library!;
    const target=store.get(ctx.workspaceId).state;if(!planLimits(target.plan,target.profile.verified).cleanExports&&!target.profile.verified)throw new HttpError(402,'Joining a shared library requires Plus, Studio, or a verified designer profile.');
    const included=shared.products.filter(product=>library.productIds.includes(product.id));
    if(!uploadDir&&JSON.stringify(included).includes('/uploads/'))throw new HttpError(503,'Shared file storage is not available.');
    const copied=uploadDir?prepareProductUploadCopies(store,link.workspace_id,ctx.workspaceId,included,uploadDir):{products:included,commit:()=>{},cleanup:()=>{}};
    let result:ReturnType<typeof store.mutate<string>>;
    try{result=store.mutate(ctx.workspaceId,state=>{
      copied.commit();const ids=new Map(copied.products.map(product=>[product.id,randomUUID()]));
      state.products.push(...copied.products.map(product=>({...structuredClone(product),id:ids.get(product.id)!,custom:true,favorite:false})));
      const copy:Library={id:randomUUID(),name:`${library.name} (copy)`,shared:false,members:[],productIds:library.productIds.flatMap(id=>ids.has(id)?[ids.get(id)!]:[])};
      state.libraries.push(copy);validateState(state);return copy.id;
    });}catch(error){copied.cleanup();throw error;}
    broadcast(ctx.workspaceId,result.state);res.status(201).json({state:result.state,libraryId:result.result});
  });
}
