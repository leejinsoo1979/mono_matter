import {useEffect,useRef,type ReactNode} from 'react';
import {X,Loader2} from 'lucide-react';
export function Modal({title,onClose,children,wide=false}:{title:string;onClose:()=>void;children:ReactNode;wide?:boolean}){const ref=useRef<HTMLDialogElement>(null);useEffect(()=>{const el=ref.current;el?.showModal();return()=>el?.close();},[]);return <dialog ref={ref} className={`modal ${wide?'modal-wide':''}`} onCancel={onClose} onClick={e=>{if(e.target===ref.current)onClose();}}><div className="modal-title"><h2>{title}</h2><button className="icon-btn" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></div>{children}</dialog>;}
export function Empty({title,description,action}:{title:string;description?:string;action?:ReactNode}){return <div className="empty"><div className="empty-symbol">＋</div><h2>{title}</h2>{description&&<p>{description}</p>}{action}</div>;}
export function Loading(){return <div className="loading"><Loader2 className="spin" size={24}/><span>Opening your workspace…</span></div>;}
export function Logo(){return <span className="logo" aria-label="monogram"><img src="/brand/monogram.png" alt="monogram"/></span>;}
