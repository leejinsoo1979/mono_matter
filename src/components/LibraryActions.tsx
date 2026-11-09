import {useEffect,useMemo,useState,type FormEvent} from 'react';
import {Copy,Pencil,Trash2,Undo2,SlidersHorizontal,Search,X} from 'lucide-react';
import type {Library,WorkspaceState} from '../../shared/types';
import {planLimits,workspaceUsage} from '../../shared/entitlements';
import {useWorkspace} from '../lib/workspace';
import {Modal} from './UI';
import './library-actions.css';

type Props={library?:Library;onDeleted?:()=>void;onSelectLibrary?:(id:string)=>void};
type Deleted={library:Library;index:number};
export function LibraryActions({library,onDeleted,onSelectLibrary}:Props){
  const state=useWorkspace(s=>s.state),update=useWorkspace(s=>s.update),notify=useWorkspace(s=>s.notify);
  const [mode,setMode]=useState<'rename'|'manage'|'delete'|null>(null),[name,setName]=useState(''),[query,setQuery]=useState(''),[selected,setSelected]=useState<Set<string>>(new Set()),[baseline,setBaseline]=useState<Set<string>>(new Set()),[deleted,setDeleted]=useState<Deleted|null>(null),[error,setError]=useState('');
  const accountEmail=state?.profile.email;
  useEffect(()=>{setDeleted(null);setMode(null);setError('');},[accountEmail]);
  const current=state?.libraries.find(item=>item.id===library?.id);
  const products=useMemo(()=>state?.products.filter(product=>`${product.name} ${product.brand} ${product.category}`.toLowerCase().includes(query.toLowerCase()))||[],[state?.products,query]);
  const withinLimits=(next:WorkspaceState)=>{
    if(!state)return false;const before=workspaceUsage(state),after=workspaceUsage(next),limits=planLimits(state.plan,state.profile.verified);
    for(const key of ['libraries','savedAssets'] as const){const limit=limits[key];if(limit!==null&&after[key]>Math.max(limit,before[key])){setError(key==='libraries'?`Your plan allows ${limit} material library. Remove another library or upgrade before adding one.`:`Your plan allows ${limit} saved products and images. Remove saved products or upgrade before adding more.`);return false;}}
    return true;
  };
  const open=(next:'rename'|'manage'|'delete')=>{if(!current)return;setError('');setMode(next);setName(current.name);if(next==='manage'){setSelected(new Set(current.productIds));setBaseline(new Set(current.productIds));setQuery('');}};
  const rename=(event:FormEvent)=>{event.preventDefault();const value=name.trim();if(!value||value.length>500){setError('Enter a library name of up to 500 characters.');return;}update(draft=>{const target=draft.libraries.find(item=>item.id===current?.id);if(target)target.name=value;});setMode(null);notify('Library renamed.');};
  const duplicate=()=>{
    if(!state||!current)return;setError('');const copy:Library={id:crypto.randomUUID(),name:`${current.name.slice(0,490)} (copy)`,productIds:[...current.productIds],shared:false,members:[]},draft=structuredClone(state);draft.libraries.push(copy);if(!withinLimits(draft))return;
    update(value=>{value.libraries.push(copy);});onSelectLibrary?.(copy.id);notify('Library duplicated.');
  };
  const remove=()=>{if(!state||!current)return;setDeleted({library:structuredClone(current),index:state.libraries.findIndex(item=>item.id===current.id)});update(draft=>{draft.libraries=draft.libraries.filter(item=>item.id!==current.id);});setMode(null);onDeleted?.();notify('Library removed. Its products remain in your workspace.');};
  const undo=()=>{
    if(!state||!deleted)return;setError('');if(state.libraries.some(item=>item.id===deleted.library.id)){setDeleted(null);return;}
    const draft=structuredClone(state);draft.libraries.splice(Math.min(deleted.index,draft.libraries.length),0,deleted.library);if(!withinLimits(draft))return;
    const restored=structuredClone(deleted.library);update(value=>{value.libraries.splice(Math.min(deleted.index,value.libraries.length),0,restored);});setDeleted(null);onSelectLibrary?.(restored.id);notify('Library restored.');
  };
  const saveProducts=()=>{
    if(!state||!current)return;const removed=new Set([...baseline].filter(id=>!selected.has(id))),added=[...selected].filter(id=>!baseline.has(id)&&state.products.some(product=>product.id===id));
    const ids=[...new Set([...current.productIds.filter(id=>!removed.has(id)),...added])],draft=structuredClone(state);draft.libraries.find(item=>item.id===current.id)!.productIds=ids;if(!withinLimits(draft))return;
    update(value=>{const target=value.libraries.find(item=>item.id===current.id);if(target)target.productIds=[...new Set([...target.productIds.filter(id=>!removed.has(id)),...added])];});setMode(null);notify('Library products updated.');
  };
  if(!state||(!current&&!deleted))return null;
  return <section className="library-actions" aria-label="Library management">
    {deleted&&<div className="library-undo" role="status"><span>“{deleted.library.name}” removed. Products are kept.</span><button onClick={undo}><Undo2 size={14}/>Undo</button><button className="library-dismiss" onClick={()=>setDeleted(null)} aria-label="Dismiss undo"><X size={14}/></button></div>}
    {current&&<div className="library-action-buttons"><span>Manage this library</span><button onClick={()=>open('rename')}><Pencil size={14}/>Rename</button><button onClick={duplicate}><Copy size={14}/>Duplicate</button><button onClick={()=>open('manage')}><SlidersHorizontal size={14}/>Manage products</button><button className="library-delete" onClick={()=>open('delete')}><Trash2 size={14}/>Delete library</button></div>}
    {error&&!mode&&<p className="library-action-error" role="alert">{error}</p>}
    {mode&&current&&<Modal title={mode==='rename'?'Rename library':mode==='manage'?'Manage library products':'Delete library'} onClose={()=>{setMode(null);setError('');}} wide={mode==='manage'}>
      {mode==='rename'?<form className="library-action-form" onSubmit={rename}><label>Library name<input required autoFocus maxLength={500} value={name} onChange={event=>setName(event.target.value)}/></label><div><button type="button" className="pill" onClick={()=>setMode(null)}>Cancel</button><button className="primary" type="submit">Save name</button></div></form>:mode==='delete'?<div className="library-action-form"><p>Delete “{current.name}”? Your products, boards, and schedules will remain in your workspace.</p><p className="muted">You can undo this action after deleting.</p><div><button className="pill" onClick={()=>setMode(null)}>Cancel</button><button className="library-confirm-delete" onClick={remove}>Delete library</button></div></div>:<div className="library-product-manager"><p>Choose which products belong to this library.</p><label className="library-product-search"><Search size={15}/><input aria-label="Search library products" placeholder="Search products or brands" value={query} onChange={event=>setQuery(event.target.value)}/></label><div className="library-product-list">{products.map(product=><label key={product.id}><input type="checkbox" checked={selected.has(product.id)} onChange={event=>setSelected(values=>{const next=new Set(values);if(event.target.checked)next.add(product.id);else next.delete(product.id);return next;})}/>{product.image?<img src={product.image} alt="" loading="lazy"/>:<span className="library-product-placeholder"/>}<span><strong>{product.name}</strong><small>{product.brand||product.category}</small></span></label>)}{!products.length&&<p>No products match your search.</p>}</div><div className="library-product-manager-footer"><span>{selected.size} selected</span><button className="pill" onClick={()=>setMode(null)}>Cancel</button><button className="primary" onClick={saveProducts}>Save selection</button></div></div>}
      {error&&<p className="library-action-error" role="alert">{error}</p>}
    </Modal>}
  </section>;
}
export default LibraryActions;
