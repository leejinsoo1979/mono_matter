import {useEffect,useState} from 'react';
import * as THREE from 'three';
export function useTextureResource(url:string|undefined,srgb=false,repeatX=1,repeatY=1,rotation=0){
  const [texture,setTexture]=useState<THREE.Texture>();
  const [status,setStatus]=useState<'loading'|'ready'|'error'>(url?'loading':'ready');
  useEffect(()=>{if(!url){setTexture(undefined);setStatus('ready');return;}let live=true,loaded:THREE.Texture|undefined;setTexture(undefined);setStatus('loading');
    new THREE.TextureLoader().load(url,value=>{loaded=value;value.wrapS=value.wrapT=THREE.RepeatWrapping;value.anisotropy=8;if(srgb)value.colorSpace=THREE.SRGBColorSpace;if(live){setTexture(value);setStatus('ready');}else value.dispose();},undefined,()=>{if(live){setTexture(undefined);setStatus('error');}});
    return()=>{live=false;loaded?.dispose();};
  },[url,srgb]);
  useEffect(()=>{if(!texture)return;texture.repeat.set(repeatX,repeatY);texture.center.set(.5,.5);texture.rotation=THREE.MathUtils.degToRad(rotation);texture.needsUpdate=true;},[texture,repeatX,repeatY,rotation]);
  return {texture,status};
}
export function useTextureMap(url:string|undefined,srgb=false,repeatX=1,repeatY=1,rotation=0){return useTextureResource(url,srgb,repeatX,repeatY,rotation).texture;}
