import {useEffect, useState, type ReactNode, type FormEvent} from 'react';
import {ArrowUpRight, Check, CheckCircle2, GraduationCap, KeyRound, Loader2, Plus, ShieldCheck, Unplug} from 'lucide-react';
import {api, saveWorkspaceNow, useWorkspace} from '../lib/workspace';
import type {WorkspaceState} from '../../shared/types';
import './account-flows.css';

type ApplicationType = 'designer' | 'education' | 'enterprise';
type Application = {id:string;type:ApplicationType;status:string;createdAt?:string;updatedAt?:string;date?:string;message?:string;reviewNote?:string};
type AccountStatus = {authenticated:boolean;email?:string;hasPassword:boolean;name?:string;usage:{projects:number;libraries:number;savedAssets:number};limits:{projects:number|null;libraries:number|null;savedAssets:number|null;cleanExports:boolean}};
type PinterestStatus = {available:boolean;connected:boolean;username?:string;account?:{username?:string}};
type PinterestBoard = {id:string;name:string;description?:string;pin_count?:number;privacy?:string};
type PinterestPin = {id:string;title?:string;description?:string;image?:string;imageUrl?:string;link?:string;media?:{images?:Record<string,{url?:string}>}};
const applicationInfo:Record<ApplicationType,{title:string;description:string;organization:string;website:string;placeholder:string}> = {
  designer:{title:'Designer verification',description:'Submit your practice details and portfolio for review. Your profile is marked verified after approval.',organization:'Studio or practice',website:'Portfolio or practice website',placeholder:'Tell us about your practice and the design work in your portfolio.'},
  education:{title:'Education plan',description:'Students and educators can request education access. Your current plan stays active while the application is reviewed.',organization:'School or university',website:'Course or faculty website',placeholder:'Your course, role, and expected graduation date, if applicable.'},
  enterprise:{title:'Enterprise',description:'Tell us about your team, workflow, and requirements. Track the enquiry here after submission.',organization:'Company or organization',website:'Company website',placeholder:'Team size, required tools, and anything your organization needs.'},
};

export function ApplicationFlow({type,compact=false,onSubmitted}:{type:ApplicationType;compact?:boolean;onSubmitted?:()=>void}) {
  const profile=useWorkspace(s=>s.state!.profile);
  const [applications,setApplications]=useState<Application[]>([]);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[editing,setEditing]=useState(false);
  const [name,setName]=useState(profile.name),[email,setEmail]=useState(profile.email),[organization,setOrganization]=useState(''),[website,setWebsite]=useState(''),[message,setMessage]=useState(''),[evidenceUrl,setEvidenceUrl]=useState(''),[country,setCountry]=useState(profile.country),[course,setCourse]=useState(''),[graduationDate,setGraduationDate]=useState('');
  const info=applicationInfo[type];
  useEffect(()=>{const controller=new AbortController();setLoading(true);api<{applications:Application[]}>('/api/applications',{signal:controller.signal}).then(result=>setApplications(result.applications||[])).catch(reason=>{if(!controller.signal.aborted)setError(reason.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[]);
  const previous=applications.filter(item=>item.type===type).at(0);
  const pending=previous&&['submitted','pending','in_review'].includes(previous.status);
  const submit=async(event:FormEvent)=>{
    event.preventDefault();setError('');setBusy(true);
    try{
      const result=await api<{application:Application}>('/api/applications',{method:'POST',body:JSON.stringify({type,name,email,organization,website,message,evidenceUrl,country,course,graduationDate})});
      setApplications(items=>[result.application,...items.filter(item=>item.id!==result.application.id)]);setEditing(false);onSubmitted?.();
    }catch(reason){setError((reason as Error).message);}finally{setBusy(false);}
  };
  return <section className={`account-flow${compact?' account-flow-compact':''}`} aria-label={info.title}>
    <div className="account-flow-heading"><div className="account-flow-icon">{type==='designer'?<ShieldCheck size={19}/>:type==='education'?<GraduationCap size={19}/>:<ArrowUpRight size={19}/>}</div><div><h3>{info.title}</h3><p>{info.description}</p></div></div>
    {loading?<p className="account-inline-loading"><Loader2 className="spin" size={14}/>Loading application status…</p>:<>
      {previous&&<div className={`application-state application-${previous.status}`} role="status"><div><strong>{previous.status==='approved'?'Approved':previous.status==='rejected'?'Changes required':previous.status==='in_review'?'Under review':'Application submitted'}</strong><span>{new Date(previous.createdAt||previous.date||previous.updatedAt||Date.now()).toLocaleDateString()}</span></div>{previous.reviewNote&&<p>{previous.reviewNote}</p>}{pending&&<p>We have saved your application. Approval has not been granted yet.</p>}</div>}
      {!editing&&!pending&&<button className="pill" type="button" onClick={()=>setEditing(true)} disabled={previous?.status==='approved'}>{previous?.status==='approved'?<><CheckCircle2 size={14}/>Approved</>:previous?'Update application':'Apply now'}<ArrowUpRight size={13}/></button>}
      {editing&&<form className="account-flow-form" onSubmit={submit}>
        <div className="form-row"><label>Name<input required maxLength={160} autoComplete="name" value={name} onChange={event=>setName(event.target.value)}/></label><label>Email<input required maxLength={254} type="email" autoComplete="email" value={email} onChange={event=>setEmail(event.target.value)}/></label></div>
        <label>{info.organization}<input required maxLength={200} autoComplete="organization" value={organization} onChange={event=>setOrganization(event.target.value)}/></label>
        <label>{info.website}<input type="url" maxLength={2000} placeholder="https://" required={type==='designer'} value={website} onChange={event=>setWebsite(event.target.value)}/></label>
        {type==='designer'&&<label>Supporting document or portfolio link<input type="url" maxLength={2000} placeholder="https://" value={evidenceUrl} onChange={event=>setEvidenceUrl(event.target.value)}/></label>}
        {type==='education'&&<><div className="form-row"><label>Course or role<input required maxLength={200} value={course} onChange={event=>setCourse(event.target.value)}/></label><label>Expected graduation date<input type="date" value={graduationDate} onChange={event=>setGraduationDate(event.target.value)}/></label></div><label>Student or educator verification link<input required type="url" maxLength={2000} placeholder="https://" value={evidenceUrl} onChange={event=>setEvidenceUrl(event.target.value)}/></label></>}
        <label>Country<input required maxLength={100} value={country} onChange={event=>setCountry(event.target.value)}/></label>
        <label>{type==='enterprise'?'Requirements':'Supporting details'}<textarea required minLength={10} maxLength={6000} rows={4} placeholder={info.placeholder} value={message} onChange={event=>setMessage(event.target.value)}/></label>
        <div className="account-form-actions"><button className="pill" type="button" disabled={busy} onClick={()=>setEditing(false)}>Cancel</button><button className="primary" type="submit" disabled={busy}>{busy?'Submitting…':'Submit application'}</button></div>
      </form>}
    </>}
    {error&&<p className="form-error" role="alert">{error}</p>}
  </section>;
}

export function AccountSecurity({children}:{children:ReactNode}) {
  const [account,setAccount]=useState<AccountStatus|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(false),[editing,setEditing]=useState(false);
  const [current,setCurrent]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState('');
  const notify=useWorkspace(s=>s.notify);
  useEffect(()=>{const controller=new AbortController();api<AccountStatus>('/api/account/status',{signal:controller.signal}).then(setAccount).catch(reason=>{if(!controller.signal.aborted)setError(reason.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[]);
  const submit=async(event:FormEvent)=>{
    event.preventDefault();setError('');
    if(password!==confirm){setError('The passwords do not match.');return;}
    if(password.length<8||password.length>128){setError('Use between 8 and 128 characters.');return;}
    setBusy(true);
    try{await api('/api/account/password',{method:'POST',body:JSON.stringify({newPassword:password,...(account?.hasPassword?{currentPassword:current}:{})})});setPassword('');setCurrent('');setConfirm('');setEditing(false);setAccount(value=>value?{...value,hasPassword:true}:value);notify('Your password has been saved.');}catch(reason){setError((reason as Error).message);}finally{setBusy(false);}
  };
  if(loading)return <p className="account-inline-loading"><Loader2 className="spin" size={14}/>Loading account…</p>;
  if(!account?.authenticated)return <>{error&&<p className="form-error" role="alert">{error}</p>}{children}</>;
  return <section className="account-flow" aria-label="Account security"><div className="account-flow-heading"><div className="account-flow-icon"><KeyRound size={18}/></div><div><h3>Signed in as {account.email}</h3><p>{account.hasPassword?'Manage the password for your account.':'Add a password to sign in with your email as well as your connected account.'}</p></div></div>{editing?<form className="account-flow-form" onSubmit={submit}>{account.hasPassword&&<label>Current password<input required type="password" autoComplete="current-password" value={current} onChange={event=>setCurrent(event.target.value)}/></label>}<label>New password<input required type="password" autoComplete="new-password" minLength={8} maxLength={128} value={password} onChange={event=>setPassword(event.target.value)}/></label><label>Confirm new password<input required type="password" autoComplete="new-password" minLength={8} maxLength={128} value={confirm} onChange={event=>setConfirm(event.target.value)}/></label><div className="account-form-actions"><button type="button" className="pill" disabled={busy} onClick={()=>{setEditing(false);setPassword('');setCurrent('');setConfirm('');setError('');}}>Cancel</button><button className="primary" type="submit" disabled={busy}>{busy?'Saving…':'Save password'}</button></div></form>:<button type="button" className="pill" onClick={()=>setEditing(true)}>{account.hasPassword?'Change password':'Add a password'}</button>}{error&&<p className="form-error" role="alert">{error}</p>}</section>;
}

function pinImage(pin:PinterestPin) {
  const image=pin.image||pin.imageUrl||Object.values(pin.media?.images||{}).find(item=>item.url)?.url||'';
  return /^https?:\/\//i.test(image)?image:'';
}
export function PinterestConnection() {
  const configured=useWorkspace(s=>s.capabilities.pinterest),notify=useWorkspace(s=>s.notify);
  const [status,setStatus]=useState<PinterestStatus|null>(null),[boards,setBoards]=useState<PinterestBoard[]>([]),[boardId,setBoardId]=useState(''),[boardBookmark,setBoardBookmark]=useState(''),[pinBookmark,setPinBookmark]=useState(''),[pins,setPins]=useState<PinterestPin[]>([]),[selected,setSelected]=useState<Set<string>>(new Set());
  const [busy,setBusy]=useState('status'),[error,setError]=useState(''),[expanded,setExpanded]=useState(false);
  useEffect(()=>{const controller=new AbortController();api<PinterestStatus>('/api/integrations/pinterest/status',{signal:controller.signal}).then(setStatus).catch(reason=>{if(!controller.signal.aborted)setError(reason.message);}).finally(()=>{if(!controller.signal.aborted)setBusy('');});return()=>controller.abort();},[]);
  const manage=async()=>{setExpanded(value=>!value);if(expanded||boards.length)return;setBusy('boards');setError('');try{const result=await api<{items:PinterestBoard[];bookmark?:string}>('/api/integrations/pinterest/boards');setBoards(result.items);setBoardBookmark(result.bookmark||'');}catch(reason){setError((reason as Error).message);}finally{setBusy('');}};
  const connect=async()=>{setBusy('connect');setError('');try{await saveWorkspaceNow();const result=await api<{url:string}>('/api/integrations/pinterest/connect',{method:'POST'});location.assign(result.url);}catch(reason){setError((reason as Error).message);setBusy('');}};
  const loadMoreBoards=async()=>{if(!boardBookmark)return;setBusy('boards');setError('');try{const result=await api<{items:PinterestBoard[];bookmark?:string}>(`/api/integrations/pinterest/boards?bookmark=${encodeURIComponent(boardBookmark)}`);setBoards(values=>[...values,...result.items.filter(item=>!values.some(value=>value.id===item.id))]);setBoardBookmark(result.bookmark||'');}catch(reason){setError((reason as Error).message);}finally{setBusy('');}};
  const loadPins=async(id:string,append=false)=>{setBoardId(id);if(!append){setPins([]);setSelected(new Set());setPinBookmark('');}if(!id)return;setBusy('pins');setError('');try{const result=await api<{items:PinterestPin[];bookmark?:string}>(`/api/integrations/pinterest/boards/${encodeURIComponent(id)}/pins${append&&pinBookmark?`?bookmark=${encodeURIComponent(pinBookmark)}`:''}`);setPins(values=>append?[...values,...result.items.filter(item=>!values.some(value=>value.id===item.id))]:result.items);setPinBookmark(result.bookmark||'');}catch(reason){setError((reason as Error).message);}finally{setBusy('');}};
  const importPins=async()=>{setBusy('import');setError('');try{await saveWorkspaceNow();const result=await api<{state?:WorkspaceState;imported?:number;duplicates?:number}>('/api/integrations/pinterest/import',{method:'POST',body:JSON.stringify({boardId,pinIds:[...selected]})});const state=result.state||(await api<{state:WorkspaceState}>('/api/workspace')).state;useWorkspace.getState().replace(state);notify(`${result.imported??selected.size} pins imported${result.duplicates?` · ${result.duplicates} already saved`:''}.`);setSelected(new Set());}catch(reason){setError((reason as Error).message);}finally{setBusy('');}};
  const disconnect=async()=>{setBusy('disconnect');setError('');try{await api('/api/integrations/pinterest/disconnect',{method:'DELETE'});setStatus({available:configured,connected:false});setExpanded(false);setBoards([]);setPins([]);notify('Pinterest disconnected. Imported products remain in your library.');}catch(reason){setError((reason as Error).message);}finally{setBusy('');}};
  const connected=!!status?.connected;
  return <section className="pinterest-connection"><div className="integration"><div className="integration-icon">P</div><div><strong>Pinterest</strong><p>{connected?`Connected${status?.username||status?.account?.username?` as ${status?.username||status?.account?.username}`:''}`:'Import inspiration from your Pinterest boards.'}</p></div><span className={`connection ${connected?'connected':''}`}>{busy==='status'?'Checking…':connected?'Connected':'Not connected'}</span><button type="button" className="pill" disabled={!!busy||(!configured&&!connected)} onClick={()=>void (connected?manage():connect())}>{busy==='connect'?'Connecting…':connected?'Manage':'Connect'}</button></div>{!configured&&!connected&&<p className="account-provider-note">Pinterest is not connected to this installation yet.</p>}{error&&<p className="form-error" role="alert">{error}</p>}{expanded&&connected&&<div className="pinterest-import"><div className="section-heading"><h3>Import your pins</h3><button type="button" className="text-btn" disabled={!!busy} onClick={()=>void disconnect()}><Unplug size={13}/>Disconnect</button></div><label>Choose a board<select value={boardId} disabled={!!busy} onChange={event=>void loadPins(event.target.value)}><option value="">Select a Pinterest board</option>{boards.map(board=><option key={board.id} value={board.id}>{board.name}{board.pin_count!==undefined?` (${board.pin_count})`:''}</option>)}</select></label>{boardBookmark&&<button type="button" className="text-btn" disabled={!!busy} onClick={()=>void loadMoreBoards()}>Load more boards</button>}{busy==='boards'||busy==='pins'?<p className="account-inline-loading"><Loader2 className="spin" size={14}/>Loading from Pinterest…</p>:boardId&&!pins.length?<p className="muted">This board has no available pins.</p>:null}{pins.length>0&&<><div className="pinterest-select-bar"><span>{selected.size} of {pins.length} selected</span><button className="text-btn" type="button" onClick={()=>setSelected(selected.size===pins.length?new Set():new Set(pins.map(pin=>pin.id)))}>{selected.size===pins.length?'Clear selection':'Select all'}</button></div><div className="pinterest-pin-grid">{pins.map(pin=><button type="button" key={pin.id} className={selected.has(pin.id)?'selected':''} aria-pressed={selected.has(pin.id)} onClick={()=>setSelected(value=>{const next=new Set(value);if(next.has(pin.id))next.delete(pin.id);else next.add(pin.id);return next;})}>{pinImage(pin)?<img src={pinImage(pin)} alt="" loading="lazy" referrerPolicy="no-referrer"/>:<div className="pin-no-image">No image</div>}<strong>{pin.title||'Untitled pin'}</strong><span className="pin-check">{selected.has(pin.id)?<Check size={13}/>:<Plus size={13}/>}</span></button>)}</div>{pinBookmark&&<button type="button" className="pill" disabled={!!busy} onClick={()=>void loadPins(boardId,true)}>Load more pins</button>}<button type="button" className="primary" disabled={!!busy||!selected.size} onClick={()=>void importPins()}>{busy==='import'?'Importing…':`Import ${selected.size||''} selected pins`}</button></> }</div>}</section>;
}

export function WorkspaceUsage() {
  const plan=useWorkspace(s=>s.state!.plan);
  const [account,setAccount]=useState<AccountStatus|null>(null),[error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();api<AccountStatus>('/api/account/status',{signal:controller.signal}).then(setAccount).catch(reason=>{if(!controller.signal.aborted)setError(reason.message);});return()=>controller.abort();},[plan]);
  if(error)return <p className="form-error" role="alert">{error}</p>;
  if(!account)return <p className="account-inline-loading"><Loader2 className="spin" size={14}/>Loading plan usage…</p>;
  const keys=['projects','libraries','savedAssets'] as const;
  return <section className="workspace-usage" aria-label="Plan usage"><h3>Workspace usage</h3><div>{keys.map(key=>{const value=account.usage[key],limit=account.limits[key];return <div key={key}><span>{key==='savedAssets'?'Saved products & images':key==='projects'?'Active projects':'Material libraries'}</span><strong>{value} <span>/ {limit===null?'Unlimited':limit}</span></strong>{limit!==null&&limit>0&&<progress value={Math.min(value,limit)} max={limit}/>}</div>;})}</div><p className="account-usage-note">{account.limits.cleanExports?'Your plan includes exports without monogram branding.':'PNG and PDF exports include monogram branding.'}</p></section>;
}
