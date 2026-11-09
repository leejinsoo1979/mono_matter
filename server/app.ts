import express,{type Request,type Response,type NextFunction} from 'express';
import multer from 'multer';
import Database from 'better-sqlite3';
import {betterAuth} from 'better-auth';
import {fromNodeHeaders,toNodeHandler} from 'better-auth/node';
import {APIError} from 'better-auth/api';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomBytes,randomUUID,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {mkdirSync,readFileSync,existsSync,writeFileSync,chmodSync} from 'node:fs';
import path from 'node:path';
import type {Board,Schedule,Product,Capabilities,SupplierRequest,WorkspaceState} from '../shared/types.ts';
import {HttpError,Store,validateState,validBoard,validSchedule} from './store.ts';
import {BillingService} from './billing.ts';
import {billingActive} from './billing-state.ts';
import {planLimits,workspaceUsage} from '../shared/entitlements.ts';
import {registerAccountFlows} from './account-flows.ts';
import {registerSupplierRoutes} from './supplier.ts';
import {registerCollaborationRoutes} from './collaboration.ts';
import {registerProfileRoutes,validateProfileChange} from './profiles.ts';
import {publiclyReferencedUpload} from './media.ts';
import {registerCatalogRoutes} from './catalog.ts';

type Env=Record<string,string|undefined>;
type PublicUser={id:string;name:string;email:string;image?:string|null;visitor:boolean};
type Context={workspaceId:string;user:PublicUser};
type ShareRecord={token_hash:string;workspace_id:string;project_id:string;resource_id:string;kind:'board'|'schedule';access:'view'|'review'|'edit';product_ids:string};
export type AppOptions={dataDir?:string;env?:Env;now?:()=>Date;fetchImpl?:typeof fetch;catalog?:Product[];distDir?:string};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const cookieName='monogram.visitor';
const isLoopback=(value:string)=>['127.0.0.1','::1','::ffff:127.0.0.1','localhost'].includes(value);
const text=(value:unknown,max=10000)=>typeof value==='string'&&value.length<=max?value:'';
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const tokenFrom=(req:Request)=>{
  const raw=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(`${cookieName}=`));
  const token=raw?.slice(cookieName.length+1)||'';
  return /^[a-f0-9]{64}$/.test(token)?token:'';
};
function fileType(data:Buffer):{extension:string;mime:string}|null{
  if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return{extension:'png',mime:'image/png'};
  if(data[0]===255&&data[1]===216&&data[2]===255)return{extension:'jpg',mime:'image/jpeg'};
  if(['GIF87a','GIF89a'].includes(data.subarray(0,6).toString()))return{extension:'gif',mime:'image/gif'};
  if(data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP')return{extension:'webp',mime:'image/webp'};
  if(data.subarray(0,5).toString()==='%PDF-')return{extension:'pdf',mime:'application/pdf'};
  if(data.subarray(0,4).toString()==='glTF')return{extension:'glb',mime:'model/gltf-binary'};
  return null;
}

export async function createApp(options:AppOptions={}){
  const env=options.env||process.env;
  const now=options.now||(()=>new Date());
  const fetcher=options.fetchImpl||fetch;
  const dataDir=path.resolve(options.dataDir||env.DATA_DIR||'runtime');
  const uploadDir=path.join(dataDir,'uploads');
  mkdirSync(uploadDir,{recursive:true,mode:0o700});
  const dbPath=path.join(dataDir,'monogram.sqlite');
  const db=new Database(dbPath);
  chmodSync(dbPath,0o600);
  let catalog=options.catalog;
  if(!catalog){try{catalog=JSON.parse(readFileSync(path.resolve('data/catalog.json'),'utf8')) as Product[];}catch{catalog=[];}}
  const store=new Store(db,catalog,now,env.CREDITS_TIME_ZONE||'Asia/Seoul',options.catalog?undefined:path.resolve('data/catalog.json'));
  const billing=new BillingService(store,env,fetcher);
  let secret=env.BETTER_AUTH_SECRET;
  if(!secret){
    const stored=db.prepare('SELECT value FROM secrets WHERE name=?').get('auth') as {value:string}|undefined;
    secret=stored?.value||randomBytes(48).toString('hex');
    if(!stored)db.prepare('INSERT INTO secrets(name,value) VALUES(?,?)').run('auth',secret);
  }
  const appUrl=env.APP_URL||'http://127.0.0.1:5188';
  const authUrl=env.BETTER_AUTH_URL||appUrl;
  const trustedOrigins=[...new Set([new URL(appUrl).origin,new URL(authUrl).origin,'http://127.0.0.1:5188','http://localhost:5188','http://127.0.0.1:4388','http://localhost:4388',...(env.TRUSTED_ORIGINS||'').split(',').filter(Boolean)])];
  const capabilities:Capabilities={ai:!!(env.AI_RENDER_ENDPOINT&&env.AI_API_KEY),email:!!(env.MAIL_SEND_ENDPOINT&&env.MAIL_API_KEY&&env.MAIL_FROM&&env.REQUESTS_TO),google:!!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET),stripe:!!(env.STRIPE_SECRET_KEY&&env.STRIPE_WEBHOOK_SECRET&&(env.STRIPE_PRICE_STARTER_MONTHLY||env.STRIPE_PRICE_PLUS_MONTHLY||env.STRIPE_PRICE_STARTER_ANNUAL||env.STRIPE_PRICE_PLUS_ANNUAL)),pinterest:!!(env.PINTEREST_CLIENT_ID&&env.PINTEREST_CLIENT_SECRET)};
  const passwordResetEmail=!!(env.MAIL_SEND_ENDPOINT&&env.MAIL_API_KEY&&env.MAIL_FROM);
  const resetDelivery=new AsyncLocalStorage<{failed:boolean}>();
  const auth=betterAuth({
    appName:'monogram',baseURL:authUrl,secret,database:db,
    emailAndPassword:{enabled:true,minPasswordLength:8,...(passwordResetEmail?{sendResetPassword:async({user,url}:{user:{email:string};url:string})=>{
      try{
        const response=await fetcher(env.MAIL_SEND_ENDPOINT!,{method:'POST',headers:{Authorization:`Bearer ${env.MAIL_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:env.MAIL_FROM,to:[user.email],subject:'[monogram] Reset your password',text:`A password reset was requested for your monogram account.\n\nOpen this link to choose a new password:\n${url}\n\nIf you did not request this, you can ignore this email.`}),signal:AbortSignal.timeout(20000)});
        if(!response.ok)throw new Error('Mail service rejected the reset email');
      }catch{const delivery=resetDelivery.getStore();if(delivery)delivery.failed=true;throw new APIError('SERVICE_UNAVAILABLE',{message:'Password reset email could not be sent. Please try again later.'});}
    }}:{})},
    trustedOrigins,
    socialProviders:capabilities.google?{google:{clientId:env.GOOGLE_CLIENT_ID!,clientSecret:env.GOOGLE_CLIENT_SECRET!}}:{},
    session:{expiresIn:60*60*24*7,updateAge:60*60*24},
    logger:{disabled:true},telemetry:{enabled:false},
  });
  await(await auth.$context).runMigrations();
  const app=express();
  app.disable('x-powered-by');
  const listeners=new Map<string,Set<Response>>();
  const broadcast=(workspaceId:string,state:WorkspaceState)=>{
    for(const client of listeners.get(workspaceId)||[])client.write(`event: workspace\ndata: ${JSON.stringify({revision:state.revision})}\n\n`);
  };
  app.use((req,res,next)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    if(req.path.startsWith('/api/'))res.setHeader('Cache-Control','no-store');
    if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.headers.origin&&!trustedOrigins.includes(req.headers.origin))return res.status(403).json({error:'This origin is not allowed.'});
    next();
  });
  app.post('/api/auth/request-password-reset',express.json({limit:'32kb'}),async(req,res)=>{
    if(!passwordResetEmail)return res.status(503).json({error:'Password reset email is not configured. No reset email was sent.',message:'Password reset email is not configured. No reset email was sent.'});
    // Better Auth deliberately catches background mail hook errors. This request-scoped result
    // lets the public route report an actual delivery failure without changing enumeration-safe responses.
    const delivery={failed:false};
    const response=await resetDelivery.run(delivery,()=>auth.handler(new Request(`${new URL(authUrl).origin}/api/auth/request-password-reset`,{method:'POST',headers:fromNodeHeaders(req.headers),body:JSON.stringify(req.body)})));
    if(delivery.failed)return res.status(503).json({error:'Password reset email could not be sent. Please try again later.',message:'Password reset email could not be sent. Please try again later.'});
    response.headers.forEach((value,key)=>res.setHeader(key,value));res.status(response.status).send(await response.text());
  });
  app.all('/api/auth/{*splat}',toNodeHandler(auth));
  // Stripe signatures must be checked against the unparsed request bytes.
  app.post('/api/billing/webhook',express.raw({type:'application/json',limit:'1mb'}),async(req,res)=>{
    if(!env.STRIPE_WEBHOOK_SECRET)return res.status(503).json({error:'Stripe webhook is not configured.'});
    const header=req.headers['stripe-signature'];
    if(typeof header!=='string'||!Buffer.isBuffer(req.body))throw new HttpError(400,'Invalid webhook.');
    const parts=header.split(',');const timestamp=parts.find(p=>p.startsWith('t='))?.slice(2)||'';
    const candidates=parts.filter(p=>p.startsWith('v1=')).map(p=>p.slice(3));
    const expected=createHmac('sha256',env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${req.body.toString('utf8')}`).digest('hex');
    if(!Number.isFinite(Number(timestamp))||Math.abs(now().getTime()/1000-Number(timestamp))>300||!candidates.some(v=>/^[a-f0-9]{64}$/.test(v)&&timingSafeEqual(Buffer.from(v),Buffer.from(expected))))throw new HttpError(400,'Invalid webhook signature.');
    const event=JSON.parse(req.body.toString('utf8'));
    if(!object(event)||typeof event.id!=='string'||!object(event.data)||!object(event.data.object))throw new HttpError(400,'Invalid webhook payload.');
    const result=await billing.handle(event);if(result)broadcast(result.workspaceId,result.state);
    res.json({received:true});
  });
  app.use(express.json({limit:'12mb'}));

  async function context(req:Request,res:Response,createVisitor=false):Promise<Context>{
    const session=await auth.api.getSession({headers:fromNodeHeaders(req.headers)});
    if(session){
      const workspaceId=`user:${session.user.id}`;
      const visitorToken=tokenFrom(req);
      if(visitorToken){
        const visitor=db.prepare('SELECT workspace_id FROM visitors WHERE token_hash=? AND expires_at>?').get(hash(visitorToken),now().getTime()) as {workspace_id:string}|undefined;
        if(visitor&&!db.prepare('SELECT id FROM workspaces WHERE id=?').get(workspaceId)){
          db.transaction(()=>{
            db.prepare('UPDATE workspaces SET id=? WHERE id=?').run(workspaceId,visitor.workspace_id);
            for(const table of ['workspace_catalog','shares','uploads','renders','applications','pinterest_connections','pinterest_states','pinterest_imports','billing_subscriptions','supplier_accounts','supplier_products','supplier_collections','supplier_gallery','supplier_leads','collaboration_links'])if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))db.prepare(`UPDATE ${table} SET workspace_id=? WHERE workspace_id=?`).run(workspaceId,visitor.workspace_id);
            if(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='supplier_leads'").get())db.prepare('UPDATE supplier_leads SET requester_workspace_id=? WHERE requester_workspace_id=?').run(workspaceId,visitor.workspace_id);
            db.prepare('DELETE FROM visitors WHERE token_hash=?').run(hash(visitorToken));
          })();
          res.clearCookie(cookieName,{path:'/',httpOnly:true,sameSite:'lax'});
        }
      }
      return{workspaceId,user:{id:session.user.id,name:session.user.name,email:session.user.email,image:session.user.image,visitor:false}};
    }
    const visitorToken=tokenFrom(req);
    if(visitorToken){
      const visitor=db.prepare('SELECT workspace_id FROM visitors WHERE token_hash=? AND expires_at>?').get(hash(visitorToken),now().getTime()) as {workspace_id:string}|undefined;
      if(visitor)return{workspaceId:visitor.workspace_id,user:{id:visitor.workspace_id,name:'Local visitor',email:'',visitor:true}};
    }
    if(createVisitor&&env.ALLOW_LOCAL_VISITOR!=='false'&&env.NODE_ENV!=='production'&&isLoopback(req.socket.remoteAddress||'')&&isLoopback(req.hostname)){
      const token=randomBytes(32).toString('hex');const workspaceId=`visitor:${randomUUID()}`;
      db.prepare('INSERT INTO visitors(token_hash,workspace_id,expires_at) VALUES(?,?,?)').run(hash(token),workspaceId,now().getTime()+30*24*60*60*1000);
      res.cookie(cookieName,token,{httpOnly:true,sameSite:'lax',path:'/',maxAge:30*24*60*60*1000,secure:req.secure});
      return{workspaceId,user:{id:workspaceId,name:'Local visitor',email:'',visitor:true}};
    }
    throw new HttpError(401,'Sign in to access this workspace.');
  }
  const requireContext=async(req:Request,res:Response,next:NextFunction)=>{try{res.locals.context=await context(req,res);next();}catch(error){next(error);}};
  const getContext=(res:Response)=>res.locals.context as Context;
  const shareFor=(token:string)=>{
    if(!/^[a-f0-9]{64}$/.test(token))throw new HttpError(404,'Share not found.');
    const share=db.prepare('SELECT * FROM shares WHERE token_hash=?').get(hash(token)) as ShareRecord|undefined;
    if(!share)throw new HttpError(404,'Share not found.');return share;
  };
  function resourceFor(share:ShareRecord){
    const {state}=store.get(share.workspace_id);const project=state.projects.find(p=>p.id===share.project_id&&!p.archived);
    const resource=share.kind==='board'?project?.boards.find(b=>b.id===share.resource_id):project?.schedules.find(s=>s.id===share.resource_id);
    if(!project||!resource)throw new HttpError(404,'The shared resource is no longer available.');
    return{state,project,resource};
  }
  const referencedProducts=(kind:'board'|'schedule',resource:Board|Schedule)=>[...new Set((kind==='board'?(resource as Board).items.map(i=>i.productId):(resource as Schedule).rows.map(r=>r.productId)).filter((id):id is string=>!!id))];
  app.get('/api/health',(_req,res)=>res.json({ok:true}));
  app.get('/api/capabilities',(_req,res)=>res.json(capabilities));
  app.get('/api/account/status',requireContext,(_req,res)=>{const ctx=getContext(res),{state}=store.get(ctx.workspaceId);const accounts=ctx.user.visitor?[]:db.prepare('SELECT providerId,password FROM account WHERE userId=?').all(ctx.user.id) as {providerId:string;password:string|null}[];res.json({authenticated:!ctx.user.visitor,email:ctx.user.email,hasPassword:accounts.some(account=>account.providerId==='credential'&&!!account.password),providers:accounts.map(account=>account.providerId),usage:workspaceUsage(state),limits:planLimits(state.plan,state.profile.verified)});});
  const passwordMutations=new Set<string>();
  app.post('/api/account/password',requireContext,async(req,res)=>{
    const ctx=getContext(res);if(ctx.user.visitor)throw new HttpError(401,'Sign in before updating your password.');
    const newPassword=req.body?.newPassword;if(typeof newPassword!=='string'||newPassword.length<8||newPassword.length>128)throw new HttpError(400,'Use a password between 8 and 128 characters.');
    if(passwordMutations.has(ctx.user.id))throw new HttpError(409,'A password update is already in progress.');passwordMutations.add(ctx.user.id);
    try{
      const headers=fromNodeHeaders(req.headers);
      const credential=db.prepare("SELECT password FROM account WHERE userId=? AND providerId='credential'").get(ctx.user.id) as {password:string|null}|undefined;
      if(credential?.password){
        if(typeof req.body.currentPassword!=='string'||!req.body.currentPassword)throw new HttpError(400,'Enter your current password.');
        const result=await auth.api.changePassword({headers,body:{currentPassword:req.body.currentPassword,newPassword,revokeOtherSessions:true},returnHeaders:true});
        // Revoking other sessions also rotates the current session. Forward only its cookies,
        // never Better Auth's raw session token in the JSON response.
        for(const cookie of result.headers.getSetCookie())res.append('Set-Cookie',cookie);
      }else{
        const session=await auth.api.getSession({headers,query:{disableCookieCache:true}});
        if(!session||Date.now()-new Date(session.session.createdAt).getTime()>15*60*1000)throw new HttpError(403,'Sign in again before adding a password.');
        await auth.api.setPassword({headers,body:{newPassword}});
      }
      res.json({status:true});
    }
    catch(error){if(error instanceof APIError)return res.status(error.statusCode).json({error:error.body?.message||'Your password could not be updated.'});throw error;}
    finally{passwordMutations.delete(ctx.user.id);}
  });
  app.get('/api/bootstrap',async(req,res)=>{
    const ctx=await context(req,res,true);const {state}=store.get(ctx.workspaceId);
    if(!ctx.user.visitor&&state.profile.email!==ctx.user.email){state.profile.email=ctx.user.email;if(state.profile.name==='Designer')state.profile.name=ctx.user.name;store.save(ctx.workspaceId,state);}
    res.json({state,workspaceId:ctx.workspaceId,user:ctx.user,capabilities});
  });
  app.get('/api/workspace',requireContext,(_req,res)=>{const ctx=getContext(res);res.json({state:store.get(ctx.workspaceId).state,workspaceId:ctx.workspaceId});});
  app.post('/api/workspace/validate',requireContext,(req,res)=>{validateState(req.body?.state);res.json({valid:true});});
  app.put('/api/workspace',requireContext,(req,res)=>{
    const ctx=getContext(res);
    if(req.body?.workspaceId!==undefined&&req.body.workspaceId!==ctx.workspaceId)throw new HttpError(403,'Your signed-in workspace changed. Reload before saving.');
    if(!Number.isInteger(req.body?.baseRevision)||!object(req.body?.state))throw new HttpError(400,'state and baseRevision are required.');
    const result=store.mutate(ctx.workspaceId,current=>{
      if(req.body.baseRevision!==current.revision)throw new HttpError(409,'Your workspace changed in another window. Reload and merge before saving.');
      const candidate={...req.body.state,revision:current.revision,credits:current.credits,plan:current.plan,requests:current.requests,inbox:current.inbox.map(item=>({...item,read:Array.isArray(req.body.state.inbox)?req.body.state.inbox.find((i:{id?:string})=>i?.id===item.id)?.read===true:item.read})),profile:{...req.body.state.profile,email:ctx.user.visitor?current.profile.email:ctx.user.email,verified:current.profile.verified}};
      validateState(candidate);validateProfileChange(store,ctx.workspaceId,current.profile,candidate.profile);Object.assign(current,candidate);
    });
    // Owner changes may introduce products; an edit-link visitor cannot widen this product allowlist.
    for(const share of db.prepare('SELECT * FROM shares WHERE workspace_id=?').all(ctx.workspaceId) as ShareRecord[]){
      const project=result.state.projects.find(p=>p.id===share.project_id);const resource=share.kind==='board'?project?.boards.find(b=>b.id===share.resource_id):project?.schedules.find(s=>s.id===share.resource_id);
      if(resource)db.prepare('UPDATE shares SET product_ids=? WHERE token_hash=?').run(JSON.stringify(referencedProducts(share.kind,resource)),share.token_hash);
    }
    broadcast(ctx.workspaceId,result.state);res.json({state:result.state,workspaceId:ctx.workspaceId});
  });
  app.get('/api/events',async(req,res)=>{
    let workspaceId:string;
    if(typeof req.query.share==='string')workspaceId=shareFor(req.query.share).workspace_id;
    else workspaceId=(await context(req,res)).workspaceId;
    res.status(200).set({'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    res.write(`event: workspace\ndata: ${JSON.stringify({revision:store.get(workspaceId).state.revision})}\n\n`);
    let set=listeners.get(workspaceId);if(!set){set=new Set();listeners.set(workspaceId,set);}set.add(res);
    const timer=setInterval(()=>res.write(': keepalive\n\n'),15000);timer.unref();
    res.on('close',()=>{clearInterval(timer);set?.delete(res);if(!set?.size)listeners.delete(workspaceId);});
  });
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:20*1024*1024,files:1,fields:5}});
  function saveFile(workspaceId:string,buffer:Buffer,name:string){
    const kind=fileType(buffer);if(!kind)throw new HttpError(415,'Supported uploads: PNG, JPEG, WebP, GIF, PDF, and GLB. SVG and executable content are not accepted.');
    const usage=db.prepare('SELECT COALESCE(SUM(size),0) AS total FROM uploads WHERE workspace_id=?').get(workspaceId) as {total:number};
    if(usage.total+buffer.length>200*1024*1024)throw new HttpError(413,'Workspace upload storage limit reached.');
    const filename=`${randomBytes(24).toString('hex')}.${kind.extension}`;
    const safeName=path.basename(name).replace(/[\r\n\x00-\x1f]/g,'').slice(0,240)||`upload.${kind.extension}`;
    writeFileSync(path.join(uploadDir,filename),buffer,{mode:0o600});
    db.prepare('INSERT INTO uploads(filename,workspace_id,name,mime,size) VALUES(?,?,?,?,?)').run(filename,workspaceId,safeName,kind.mime,buffer.length);
    return{url:`/uploads/${filename}`,name:safeName};
  }
  app.post('/api/upload',requireContext,upload.single('file'),(req,res)=>{
    if(!req.file)throw new HttpError(400,'Choose a file to upload.');
    res.status(201).json(saveFile(getContext(res).workspaceId,req.file.buffer,req.file.originalname));
  });
  app.get('/uploads/:file',async(req,res)=>{
    const filename=req.params.file;if(!/^[a-f0-9]+\.(png|jpg|webp|gif|pdf|glb)$/.test(filename))throw new HttpError(404,'File not found.');
    const file=db.prepare('SELECT mime,workspace_id FROM uploads WHERE filename=?').get(filename) as {mime:string;workspace_id:string}|undefined;
    if(!file)throw new HttpError(404,'File not found.');
    let owner=false;try{owner=(await context(req,res)).workspaceId===file.workspace_id;}catch(error){if(!(error instanceof HttpError&&error.status===401))throw error;}
    if(!owner&&!publiclyReferencedUpload(store,file.workspace_id,filename))throw new HttpError(404,'File not found.');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Type',file.mime);res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
    if(file.mime==='application/pdf')res.setHeader('Content-Disposition','attachment');
    res.sendFile(path.join(uploadDir,filename));
  });
  app.post('/api/share',requireContext,(req,res)=>{
    const {kind,projectId,resourceId,access}=req.body||{};
    if(!['board','schedule'].includes(kind)||!['view','review','edit'].includes(access)||!text(projectId,200)||!text(resourceId,200))throw new HttpError(400,'Invalid share options.');
    const ctx=getContext(res);const token=randomBytes(32).toString('hex');
    const share:ShareRecord={token_hash:hash(token),workspace_id:ctx.workspaceId,project_id:projectId,resource_id:resourceId,kind,access,product_ids:'[]'};const {resource}=resourceFor(share);
    share.product_ids=JSON.stringify(referencedProducts(kind,resource));
    db.prepare('INSERT INTO shares(token_hash,workspace_id,project_id,resource_id,kind,access,product_ids,created_at) VALUES(?,?,?,?,?,?,?,?)').run(share.token_hash,ctx.workspaceId,projectId,resourceId,kind,access,share.product_ids,now().toISOString());
    res.status(201).json({token,url:`${appUrl}/share/${token}`});
  });
  app.get('/api/share/:token',(req,res)=>{
    const share=shareFor(req.params.token);const {state,project,resource}=resourceFor(share);
    const allowed=new Set(JSON.parse(share.product_ids) as string[]);const ids=new Set(referencedProducts(share.kind,resource).filter(id=>allowed.has(id)));
    const {shareToken:_privateToken,...publicResource}=resource;
    const cleanExports=planLimits(state.plan).cleanExports;res.json({resource:publicResource,products:state.products.filter(p=>ids.has(p.id)),projectName:project.name,kind:share.kind,access:share.access,revision:state.revision,watermark:!cleanExports,cleanExports});
  });
  app.patch('/api/share/:token',(req,res)=>{
    const share=shareFor(req.params.token);
    if(share.kind!=='schedule'||!['review','edit'].includes(share.access))throw new HttpError(403,'This link does not allow schedule reviews.');
    const allowed=new Set(['rowId','status','remarks','baseRevision']);
    if(!object(req.body)||Object.keys(req.body).some(k=>!allowed.has(k))||!text(req.body.rowId,200)||!['approved','rejected','Approved','Rejected'].includes(String(req.body.status))||(req.body.remarks!==undefined&&(typeof req.body.remarks!=='string'||req.body.remarks.length>10000)))throw new HttpError(400,'Only a row approval, rejection, and remarks may be submitted.');
    const result=store.mutate(share.workspace_id,state=>{
      if(req.body.baseRevision!==undefined&&req.body.baseRevision!==state.revision)throw new HttpError(409,'The schedule changed. Refresh before submitting your review.');
      const schedule=state.projects.find(p=>p.id===share.project_id&&!p.archived)?.schedules.find(s=>s.id===share.resource_id);const row=schedule?.rows.find(r=>r.id===req.body.rowId);
      if(!row||!schedule)throw new HttpError(404,'Schedule row not found.');
      row.status=String(req.body.status).toLowerCase()==='approved'?'Approved':'Rejected';
      const statusColumn=schedule.columns.find(c=>c.type==='status');if(statusColumn)row.values[statusColumn.id]=row.status;
      if(req.body.remarks!==undefined){const column=schedule.columns.find(c=>c.id==='remarks');if(column)row.values[column.id]=req.body.remarks;}
      schedule.updatedAt=now().toISOString();
    });
    broadcast(share.workspace_id,result.state);res.json({ok:true,revision:result.state.revision});
  });
  app.put('/api/share/:token',(req,res)=>{
    const share=shareFor(req.params.token);if(share.access!=='edit')throw new HttpError(403,'This share link is read-only.');
    const resource=req.body?.resource;
    if(!object(resource)||resource.id!==share.resource_id||!(share.kind==='board'?validBoard(resource):validSchedule(resource))||!Number.isInteger(req.body.baseRevision))throw new HttpError(400,'Invalid shared resource.');
    const allowed=new Set(JSON.parse(share.product_ids) as string[]);if(referencedProducts(share.kind,resource as unknown as Board|Schedule).some(id=>!allowed.has(id)))throw new HttpError(403,'This link cannot access additional private products.');
    const result=store.mutate(share.workspace_id,state=>{
      if(req.body.baseRevision!==state.revision)throw new HttpError(409,'The shared resource changed. Refresh before saving.');
      const project=state.projects.find(p=>p.id===share.project_id&&!p.archived);if(!project)throw new HttpError(404,'Project not found.');
      if(share.kind==='board'){const i=project.boards.findIndex(b=>b.id===share.resource_id);if(i<0)throw new HttpError(404,'Board not found.');project.boards[i]={...resource,shareToken:project.boards[i].shareToken,updatedAt:now().toISOString()} as Board;}
      else{const i=project.schedules.findIndex(s=>s.id===share.resource_id);if(i<0)throw new HttpError(404,'Schedule not found.');project.schedules[i]={...resource,shareToken:project.schedules[i].shareToken,updatedAt:now().toISOString()} as Schedule;}
    });
    broadcast(share.workspace_id,result.state);res.json({ok:true,revision:result.state.revision});
  });
  app.delete('/api/share/:token',requireContext,(req,res)=>{
    const share=shareFor(text(req.params.token,64));if(share.workspace_id!==getContext(res).workspaceId)throw new HttpError(403,'Only the owner can revoke this link.');
    db.prepare('DELETE FROM shares WHERE token_hash=?').run(share.token_hash);res.json({ok:true});
  });
  app.post('/api/requests',requireContext,async(req,res)=>{
    const body=req.body||{};const ctx=getContext(res);const {state}=store.get(ctx.workspaceId);
    if(!['quote','sample'].includes(body.type)||!Array.isArray(body.productIds)||body.productIds.length<1||body.productIds.length>100||!body.productIds.every((id:unknown)=>typeof id==='string'&&state.products.some(p=>p.id===id))||!text(body.name,300)||!/^\S+@\S+\.\S+$/.test(text(body.email,320))||typeof body.message!=='string'||body.message.length>20000)throw new HttpError(400,'Provide valid products, name, email, and request details.');
    const request:SupplierRequest={id:randomUUID(),productIds:[...new Set(body.productIds)] as string[],type:body.type,name:body.name,email:body.email,message:body.message,status:'submitted',date:now().toISOString(),supplier:text(body.supplier,500)};
    let result=store.mutate(ctx.workspaceId,workspace=>{workspace.requests.unshift(request);workspace.inbox.unshift({id:randomUUID(),title:'Supplier request recorded',message:'Your request was saved internally. No email has been sent.',date:now().toISOString(),read:false,type:'request'});});
    let delivery:'internal'|'sent'|'failed'='internal';let message='Request recorded in your workspace. Email delivery is not configured; no supplier email was sent.';
    if(capabilities.email){
      try{
        const response=await fetcher(env.MAIL_SEND_ENDPOINT!,{method:'POST',headers:{Authorization:`Bearer ${env.MAIL_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:env.MAIL_FROM,to:env.REQUESTS_TO!.split(',').map(v=>v.trim()).filter(Boolean),reply_to:request.email,subject:`[monogram] ${request.type==='quote'?'Quote':'Sample'} request: ${request.name}`,text:`${request.message}\n\nProducts: ${request.productIds.map(id=>state.products.find(p=>p.id===id)?.name).join(', ')}\nReply to: ${request.email}`}),signal:AbortSignal.timeout(20000)});
        if(!response.ok)throw new Error('Mail delivery failed');delivery='sent';message='Request accepted by the configured mail service for delivery.';
      }catch{delivery='failed';message='Request saved, but email delivery failed. You can retry from your request history.';}
      result=store.mutate(ctx.workspaceId,workspace=>{const item=workspace.requests.find(r=>r.id===request.id);if(item)item.status=delivery==='sent'?'sent':'failed';workspace.inbox.unshift({id:randomUUID(),title:delivery==='sent'?'Request email accepted':'Request email failed',message,date:now().toISOString(),read:false,type:'request'});});
    }
    broadcast(ctx.workspaceId,result.state);res.status(201).json({request:result.state.requests.find(r=>r.id===request.id),delivery,message,state:result.state});
  });
  const aiLocks=new Set<string>();
  app.post('/api/ai/render',requireContext,async(req,res)=>{
    if(!capabilities.ai)throw new HttpError(503,'Image generation is not connected. No credits were spent.');
    const ctx=getContext(res);const prompt=text(req.body?.prompt,10000);if(!prompt.trim())throw new HttpError(400,'Enter a rendering prompt.');
    const cost=Math.max(1,Math.floor(Number(env.AI_CREDITS_PER_RENDER)||10));
    if(aiLocks.has(ctx.workspaceId))throw new HttpError(409,'A render is already running for this workspace.');
    const {state}=store.get(ctx.workspaceId);if(state.credits.daily+state.credits.monthly+state.credits.bonus<cost)throw new HttpError(402,'Not enough credits for this render.');
    let image:string|undefined;
    if(req.body.image){
      const reference=text(req.body.image,2000);const filename=reference.replace(/^\/uploads\//,'');
      const upload=db.prepare('SELECT mime FROM uploads WHERE filename=? AND workspace_id=?').get(filename,ctx.workspaceId) as {mime:string}|undefined;
      const knownProductImage=state.products.some(product=>product.image===reference||product.texture===reference||product.variants.some(variant=>variant.image===reference));
      if(upload&&upload.mime.startsWith('image/'))image=`data:${upload.mime};base64,${readFileSync(path.join(uploadDir,filename)).toString('base64')}`;
      else if(knownProductImage&&/^\/assets\/[a-zA-Z0-9._-]+$/.test(reference)){
        const buffer=readFileSync(path.resolve('public',reference.slice(1)));const kind=fileType(buffer);if(!kind?.mime.startsWith('image/'))throw new HttpError(400,'Choose a supported image.');image=`data:${kind.mime};base64,${buffer.toString('base64')}`;
      }else if(knownProductImage&&/^https:\/\//.test(reference))image=reference;
      else throw new HttpError(400,'Choose a product image or an image uploaded to this workspace.');
    }
    aiLocks.add(ctx.workspaceId);
    try{
      const response=await fetcher(env.AI_RENDER_ENDPOINT!,{method:'POST',headers:{Authorization:`Bearer ${env.AI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:text(req.body.model,200)||env.AI_MODEL||'image',prompt,n:1,size:'1024x1024',...(image?{image}:{})}),signal:AbortSignal.timeout(120000)});
      if(!response.ok)throw new HttpError(502,'The rendering provider could not complete the request. No credits were spent.');
      const output=await response.json() as {url?:string;image?:string;data?:{url?:string;b64_json?:string}[]};
      let url=output.url||output.data?.[0]?.url||'';const base64=output.data?.[0]?.b64_json;
      if(base64){if(base64.length>28_000_000)throw new HttpError(502,'The rendered image is too large. No credits were spent.');url=saveFile(ctx.workspaceId,Buffer.from(base64,'base64'),'render.png').url;}
      if(!/^https:\/\//.test(url)&&!/^\/uploads\//.test(url))throw new HttpError(502,'The provider returned no usable image. No credits were spent.');
      const id=randomUUID();
      const result=store.mutate(ctx.workspaceId,workspace=>{
        if(workspace.credits.daily+workspace.credits.monthly+workspace.credits.bonus<cost)throw new HttpError(409,'Your credit balance changed while rendering. No credits were spent.');
        let left=cost;for(const pool of ['daily','monthly','bonus'] as const){const spent=Math.min(left,workspace.credits[pool]);workspace.credits[pool]-=spent;left-=spent;if(spent)workspace.credits.history.unshift({id:randomUUID(),activity:'AI render',amount:-spent,type:pool,date:now().toISOString()});}
        db.prepare('INSERT INTO renders(id,workspace_id,prompt,url,created_at) VALUES(?,?,?,?,?)').run(id,ctx.workspaceId,prompt,url,now().toISOString());
      });
      broadcast(ctx.workspaceId,result.state);res.status(201).json({id,url,creditsSpent:cost,state:result.state});
    }catch(error){if(error instanceof HttpError)throw error;throw new HttpError(502,'The rendering provider was unavailable. No credits were spent.');}finally{aiLocks.delete(ctx.workspaceId);}
  });
  app.get('/api/ai/renders',requireContext,(_req,res)=>res.json({renders:db.prepare('SELECT id,prompt,url,created_at AS createdAt FROM renders WHERE workspace_id=? ORDER BY created_at DESC').all(getContext(res).workspaceId)}));
  app.post('/api/billing/checkout',requireContext,async(req,res)=>{
    if(!capabilities.stripe)throw new HttpError(503,'Billing is not configured. No payment or subscription was created.');
    const ctx=getContext(res);if(ctx.user.visitor)throw new HttpError(401,'Create an account before starting a paid subscription.');
    const {plan,period}=req.body||{};
    if(!['Starter','Plus'].includes(plan)||!['monthly','annual'].includes(period))throw new HttpError(400,'Choose a supported plan and billing period.');
    const existing=billing.row(ctx.workspaceId);if(existing&&billingActive(existing,Math.floor(now().getTime()/1000)))throw new HttpError(409,'This account already has a subscription. Manage it through the billing portal.');
    store.get(ctx.workspaceId);
    const price=env[`STRIPE_PRICE_${String(plan).toUpperCase()}_${String(period).toUpperCase()}`];if(!price)throw new HttpError(503,'This plan is not configured for checkout.');
    const body=new URLSearchParams({mode:'subscription','line_items[0][price]':price,'line_items[0][quantity]':'1',success_url:`${appUrl}/?checkout=success`,cancel_url:`${appUrl}/?checkout=cancelled`,client_reference_id:ctx.user.id,customer_email:ctx.user.email,'metadata[workspaceId]':ctx.workspaceId,'metadata[plan]':plan,'subscription_data[metadata][workspaceId]':ctx.workspaceId,'subscription_data[metadata][plan]':plan});
    try{
      const checkout=await billing.stripe('checkout/sessions',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});if(typeof checkout.url!=='string'||!checkout.url.startsWith('https://checkout.stripe.com/'))throw new Error('Checkout failed');res.json({url:checkout.url});
    }catch{throw new HttpError(502,'Checkout could not be created. No subscription has been activated.');}
  });
  app.get('/api/billing/status',requireContext,(_req,res)=>res.json(billing.status(getContext(res).workspaceId)));
  app.post('/api/billing/portal',requireContext,async(_req,res)=>{
    if(!capabilities.stripe)throw new HttpError(503,'Billing is not connected.');
    const row=billing.row(getContext(res).workspaceId);if(!row?.customer_id)throw new HttpError(404,'No billing account is linked to this workspace.');
    const session=await billing.stripe('billing_portal/sessions',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({customer:row.customer_id,return_url:appUrl})});
    if(typeof session.url!=='string'||!session.url.startsWith('https://billing.stripe.com/'))throw new HttpError(502,'The billing portal could not be opened.');res.json({url:session.url});
  });
  registerAccountFlows(app,{store,requireContext,getContext,broadcast,env,fetcher,secret,appUrl});
  registerSupplierRoutes(app,{store,requireContext,getContext,broadcast,now,uploadDir});
  registerCollaborationRoutes(app,{store,requireContext,getContext,broadcast,now,appUrl,uploadDir});
  registerProfileRoutes(app,{store,uploadDir});
  registerCatalogRoutes(app,{store,requireContext,getContext,broadcast});
  app.use('/api',(_req,res)=>res.status(404).json({error:'API endpoint not found.'}));
  const distDir=path.resolve(options.distDir||'dist');
  if(existsSync(path.join(distDir,'index.html'))){app.use(express.static(distDir));app.get('/{*splat}',(_req,res)=>res.sendFile(path.join(distDir,'index.html')));}
  app.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
    if(res.headersSent)return res.end();
    if(error instanceof HttpError)return res.status(error.status).json({error:error.message});
    if(error instanceof multer.MulterError)return res.status(error.code==='LIMIT_FILE_SIZE'?413:400).json({error:'The upload was rejected. Maximum file size is 20 MB.'});
    if(object(error)&&error.type==='entity.too.large')return res.status(413).json({error:'Workspace data is too large.'});
    if(error instanceof SyntaxError)return res.status(400).json({error:'Invalid JSON.'});
    res.status(500).json({error:'The server could not complete this request.'});
  });
  return{app,db,auth,store,capabilities,close:()=>{for(const clients of listeners.values())for(const client of clients)client.end();listeners.clear();db.close();}};
}
