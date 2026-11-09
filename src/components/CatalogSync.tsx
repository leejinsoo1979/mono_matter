import {useState} from 'react';
import {RefreshCw,DatabaseBackup,CheckCircle2} from 'lucide-react';
import type {WorkspaceState} from '../../shared/types';
import {api,downloadFile,saveWorkspaceNow,useWorkspace} from '../lib/workspace';
import './catalog-sync.css';

type Result={state:WorkspaceState;added:number;refreshed:number;preservedCustom:number;catalogCount:number;message:string};
export function CatalogSync(){
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<Result|null>(null);const notify=useWorkspace(state=>state.notify);
  const restore=async()=>{
    setBusy(true);setError('');setResult(null);
    try{
      await saveWorkspaceNow();const current=useWorkspace.getState().state;if(!current)throw new Error('Open your workspace before refreshing the catalog.');
      downloadFile(`monogram-before-catalog-refresh-${new Date().toISOString().replace(/[:.]/g,'-')}.json`,JSON.stringify(current,null,2));
      const response=await api<Result>('/api/catalog/sync',{method:'POST',body:JSON.stringify({mode:'restore-public-catalog'})});useWorkspace.getState().replace(response.state);setResult(response);notify(`Original catalog refreshed · ${response.catalogCount} products.`);
    }catch(reason){setError(reason instanceof Error?reason.message:'The catalog could not be refreshed.');}finally{setBusy(false);}
  };
  return <section className="catalog-sync" aria-label="Original product catalog"><div className="catalog-sync-heading"><DatabaseBackup size={20}/><div><h3>Refresh the original catalog</h3><p>Get missing products, variants, 3D models, and material settings from the original catalog.</p></div></div><p>This restores original details for catalog products you have not marked custom. Custom products, favorites, boards, projects, and library selections are kept.</p><p className="catalog-sync-backup">A workspace backup download starts before the refresh, so you can keep a copy of your current catalog details.</p><button type="button" className="pill" onClick={()=>void restore()} disabled={busy}><RefreshCw size={14} className={busy?'spin':undefined}/>{busy?'Refreshing catalog…':'Back up & refresh catalog'}</button>{result&&<p className="catalog-sync-result" role="status"><CheckCircle2 size={15}/>{result.catalogCount} original products · {result.added} added · {result.refreshed} refreshed · {result.preservedCustom} custom products kept</p>}{error&&<p className="catalog-sync-error" role="alert">{error}</p>}</section>;
}
export default CatalogSync;
