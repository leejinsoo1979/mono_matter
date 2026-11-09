import {useEffect,useState} from 'react';
import {ArrowLeft,MapPin,ShieldCheck,Loader2} from 'lucide-react';
import {api} from '../lib/workspace';
import {Logo} from './UI';
import './public-profile.css';

type Profile={name:string;username:string;country:string;bio:string;avatar:string;verified:boolean};
export default function PublicProfile({username,onBack}:{username:string;onBack:()=>void}){
  const [profile,setProfile]=useState<Profile|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  useEffect(()=>{const controller=new AbortController();setLoading(true);setError('');setProfile(null);api<Profile>(`/api/profiles/${encodeURIComponent(username)}`,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setProfile(value);}).catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'This profile could not be opened.');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[username]);
  return <main className="public-profile-page"><header><button className="pill" onClick={onBack}><ArrowLeft size={15}/>Back to workspace</button><Logo/></header>{loading?<div className="public-profile-message" role="status"><Loader2 className="spin" size={22}/>Loading profile…</div>:error?<section className="public-profile-message" role="alert"><h1>Profile unavailable</h1><p>{error}</p><button className="pill" onClick={onBack}>Open workspace</button></section>:profile&&<article className="public-profile-card"><div className="public-profile-avatar">{profile.avatar?<img src={profile.avatar} alt={`${profile.name}'s profile`} referrerPolicy="no-referrer"/>:<span aria-hidden="true">{profile.name.slice(0,1).toUpperCase()||'M'}</span>}</div><p className="public-profile-handle">@{profile.username}</p><h1>{profile.name}{profile.verified&&<ShieldCheck size={22} aria-label="Verified designer"/>}</h1>{profile.country&&<p className="public-profile-country"><MapPin size={15}/>{profile.country}</p>}{profile.bio&&<p className="public-profile-bio">{profile.bio}</p>}</article>}</main>;
}
export {PublicProfile};
