import {useLayoutEffect} from 'react';
import {Monitor,Moon,Sun} from 'lucide-react';
import {useWorkspace} from '../lib/workspace';
import './theme.css';

type ThemeMode='light'|'dark'|'system';
const modes=[{value:'light',label:'Light',Icon:Sun},{value:'dark',label:'Dark',Icon:Moon},{value:'system',label:'System',Icon:Monitor}] as const;
const modeOf=(value:unknown):ThemeMode=>value==='light'||value==='dark'?value:'system';

/** Account settings remain authoritative; public pages follow the device before an account loads. */
export function ThemeSync(){
  const mode=useWorkspace(state=>modeOf(state.state?.settings.theme));
  useLayoutEffect(()=>{
    const preference=window.matchMedia('(prefers-color-scheme: dark)');
    const apply=()=>{const resolved=mode==='system'?(preference.matches?'dark':'light'):mode;document.documentElement.dataset.theme=resolved;document.documentElement.dataset.themeMode=mode;document.documentElement.style.colorScheme=resolved;};
    apply();preference.addEventListener('change',apply);
    return()=>preference.removeEventListener('change',apply);
  },[mode]);
  return null;
}

export function ThemePicker(){
  const mode=useWorkspace(state=>modeOf(state.state?.settings.theme));
  const available=useWorkspace(state=>!!state.state);
  const update=useWorkspace(state=>state.update);
  return <div className="theme-picker"><span>Theme</span><div role="group" aria-label="Theme">{modes.map(({value,label,Icon})=><button key={value} type="button" className={mode===value?'selected':''} aria-pressed={mode===value} disabled={!available} onClick={()=>update(state=>{state.settings.theme=value;})}><Icon size={13}/><span>{label}</span></button>)}</div></div>;
}
