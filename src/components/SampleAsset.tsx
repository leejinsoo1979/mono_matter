import * as THREE from 'three';
import type {Product} from '../../shared/types';
import {useTextureResource} from '../lib/useTextureMap';
import {Html} from '@react-three/drei';

/** Samples follow source geometry metadata; alpha-plane is deliberately a flat image. */
export default function SampleAsset({product,maxSize=1.5}:{product:Product;maxSize?:number}){
  const m=product.material,rx=1/(m?.textureWidth||1),ry=1/(m?.textureHeight||1),r=m?.textureRotation||0;
  const uv=(channel:'diffuse'|'normal'|'orm'|'transmissionThickness')=>{const t=m?.mapTransforms?.[channel];return [t?.x??rx,t?.y??ry,t?.rotation??r] as const;};
  const maps=[useTextureResource(m?.texture||product.texture||product.image,true,...uv('diffuse')),useTextureResource(m?.ormMap,false,...uv('orm')),useTextureResource(m?.roughnessMap,false,...uv('orm')),useTextureResource(m?.normalMap,false,...uv('normal')),useTextureResource(m?.opacityMap,false,...uv('diffuse')),useTextureResource(m?.transmissionMap,false,...uv('transmissionThickness')),useTextureResource(m?.thicknessMap,false,...uv('transmissionThickness')),useTextureResource(m?.bumpMap,false,...uv('normal'))];
  const [map,orm,rough,normal,opacity,transmission,thickness,bump]=maps.map(v=>v.texture);
  const status=maps.some(v=>v.status==='error')?'error':maps.some(v=>v.status==='loading')?'loading':'ready';
  const raw=product.modelSize,max=raw?Math.max(...raw):1;
  const w=raw&&max>0?raw[0]/max*maxSize:maxSize,d=raw&&max>0?raw[2]/max*maxSize:maxSize;
  const h=raw&&max>0?raw[1]/max*maxSize:.07;
  const plane=product.sampleKind==='alpha-plane';
  return <mesh userData={{assetStatus:status}} castShadow={!plane} receiveShadow position={[0,plane?.004:Math.max(h,.012)/2,0]} rotation={plane?[-Math.PI/2,0,0]:[0,0,0]}>
    {plane?<planeGeometry args={[w||maxSize,d||maxSize]}/>:<boxGeometry args={[w||maxSize,Math.max(h,.012),d||maxSize]}/>}
    {plane?<meshBasicMaterial map={map} transparent alphaTest={.03} side={THREE.DoubleSide} color="#ffffff"/>:<meshPhysicalMaterial color={m?.color||(map?'#ffffff':product.color)} map={map} roughness={m?.roughness??.65} metalness={m?.metalness??0} ior={m?.ior??1.5} opacity={m?.opacity??1} transparent={(m?.opacity??1)<1||!!opacity} alphaMap={opacity} roughnessMap={rough||orm} metalnessMap={orm} aoMap={orm} aoMapIntensity={m?.aoMapIntensity??1} bumpMap={bump} bumpScale={m?.bumpScale??1} sheen={m?.sheen??0} sheenColor={m?.sheenColor||'#ffffff'} sheenRoughness={m?.sheenRoughness??1} clearcoat={m?.clearcoat??0} clearcoatRoughness={m?.clearcoatRoughness??0} specularIntensity={m?.specularIntensity??1} normalMap={m?.normal===false?undefined:normal} normalScale={new THREE.Vector2(m?.normalScale??1,m?.normalScale??1)} transmission={m?.transmission??0} transmissionMap={transmission} thickness={m?.thickness??0} thicknessMap={thickness} attenuationDistance={m?.distance||Infinity} attenuationColor={m?.attenuationColor||'#ffffff'}/>}
    {status==='error'&&<Html center><div className="model-load-state" role="alert">A material texture could not be loaded.</div></Html>}
  </mesh>;
}
