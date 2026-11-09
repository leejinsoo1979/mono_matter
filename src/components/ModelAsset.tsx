import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {useThree} from '@react-three/fiber';
import {Html} from '@react-three/drei';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {DRACOLoader} from 'three/addons/loaders/DRACOLoader.js';
import * as THREE from 'three';
import type {MaterialSettings} from '../../shared/types';
import {modelPlacement} from '../lib/scene-math';

type Status='loading'|'ready'|'error';
type MapTransform={x:number;y:number;rotation:number};
type Overrides=Partial<MaterialSettings>&{color?:string;sheen?:number;sheenColor?:string;sheenRoughness?:number;clearcoat?:number;clearcoatRoughness?:number;specularIntensity?:number;aoMapIntensity?:number;mapTransforms?:Partial<Record<'diffuse'|'normal'|'orm'|'transmissionThickness',MapTransform>>};
type Props={url:string;maxSize?:number;onReady?:(object:THREE.Object3D)=>void;onStatus?:(status:Status)=>void;overrides?:Overrides;colorOverride?:string;sourceMaterial?:boolean};
const mapKeys=['texture','roughnessMap','opacityMap','bumpMap','normalMap','ormMap','transmissionMap','thicknessMap'] as const;
type MapKey=typeof mapKeys[number];
type MaterialWithMaps=THREE.Material&Record<string,unknown>;
type Binding={mesh:THREE.Mesh;original:THREE.Material|THREE.Material[]};

/** Each model owns working copies; embedded materials and UV transforms remain a reversible baseline. */
export function createModelMaterialOverrides(scene:THREE.Object3D,sourceMaterial=false){
  const bindings:Binding[]=[],standardCopies=new Map<THREE.Material,THREE.Material>(),physicalCopies=new Map<THREE.Material,THREE.MeshPhysicalMaterial>(),uvCopies=new Map<THREE.Texture,Map<string,THREE.Texture>>();
  scene.traverse(node=>{if(node instanceof THREE.Mesh)bindings.push({mesh:node,original:node.material});});
  const originalMaterials=new Set(bindings.flatMap(binding=>Array.isArray(binding.original)?binding.original:[binding.original]));
  const apply=(overrides:Overrides={},colorOverride?:string,maps:Partial<Record<MapKey,THREE.Texture>>={})=>{
    const has=(key:keyof Overrides)=>Object.prototype.hasOwnProperty.call(overrides,key);
    const changed=Object.keys(overrides).length>0||colorOverride!==undefined;
    const physical=['ior','transmission','thickness','distance','attenuationColor','transmissionMap','thicknessMap','sheen','sheenColor','sheenRoughness','clearcoat','clearcoatRoughness','specularIntensity'].some(key=>has(key as keyof Overrides));
    const transformUV=['textureWidth','textureHeight','textureRotation'].some(key=>has(key as keyof Overrides))||!!overrides.mapTransforms;
    const materials=new Map<THREE.Material,THREE.Material>();
    for(const original of originalMaterials){
      if(sourceMaterial&&original.name!=='target'){materials.set(original,original);continue;}
      if(!changed){materials.set(original,original);continue;}
      let copy:THREE.Material;
      if(sourceMaterial||((physical||(!(original instanceof THREE.MeshStandardMaterial)&&['roughness','metalness','normalMap','normalScale','bumpMap','bumpScale','ormMap'].some(key=>has(key as keyof Overrides))))&&!(original instanceof THREE.MeshPhysicalMaterial))){
        let converted=physicalCopies.get(original);
        if(!converted){converted=new THREE.MeshPhysicalMaterial();physicalCopies.set(original,converted);}
        // Reset physical defaults as well as all original Standard/Basic properties on each application.
        const defaults=new THREE.MeshPhysicalMaterial();converted.copy(defaults);defaults.dispose();
        if(sourceMaterial){converted.name=original.name;converted.side=original.side;}
        else if(original instanceof THREE.MeshStandardMaterial)THREE.MeshStandardMaterial.prototype.copy.call(converted,original);
        else{THREE.Material.prototype.copy.call(converted,original);const source=original as MaterialWithMaps;for(const key of ['color','map','alphaMap','aoMap','emissive','emissiveMap','normalMap','bumpMap','bumpScale','side']){const value=source[key];if(value!==undefined){if(value instanceof THREE.Color)(converted as unknown as Record<string,unknown>)[key]=value.clone();else (converted as unknown as Record<string,unknown>)[key]=value;}}}
        copy=converted;
      }else{
        copy=standardCopies.get(original)||original.clone();standardCopies.set(original,copy);copy.copy(original);
      }
      const material=copy as MaterialWithMaps;
      const color=colorOverride??overrides.color;if(color!==undefined&&material.color instanceof THREE.Color)material.color.set(color);
      for(const key of ['roughness','metalness','opacity','bumpScale','ior','transmission','thickness','sheen','sheenRoughness','clearcoat','clearcoatRoughness','specularIntensity','aoMapIntensity'] as const)if(has(key)&&overrides[key]!==undefined&&typeof material[key]==='number')material[key]=overrides[key];
      if(has('distance')&&typeof material.attenuationDistance==='number')material.attenuationDistance=overrides.distance!>0?overrides.distance!:Infinity;
      if(has('attenuationColor')&&material.attenuationColor instanceof THREE.Color)material.attenuationColor.set(overrides.attenuationColor||'#ffffff');
      if(has('sheenColor')&&material.sheenColor instanceof THREE.Color)material.sheenColor.set(overrides.sheenColor||'#ffffff');
      const textureSlots:[MapKey,string][]=[['texture','map'],['roughnessMap','roughnessMap'],['opacityMap','alphaMap'],['bumpMap','bumpMap'],['normalMap','normalMap'],['transmissionMap','transmissionMap'],['thicknessMap','thicknessMap']];
      if(has('ormMap')){for(const slot of ['aoMap','roughnessMap','metalnessMap'])if(slot in material)material[slot]=maps.ormMap||null;}
      // A dedicated channel map supplied by the user takes priority over a combined source ORM map.
      for(const [key,slot] of textureSlots)if(has(key)&&slot in material)material[slot]=maps[key]||null;
      if(overrides.normal===false&&has('normal')&&'normalMap' in material)material.normalMap=null;
      if(has('normalScale')&&material.normalScale instanceof THREE.Vector2)material.normalScale.setScalar(overrides.normalScale??1);
      if(has('opacity')||has('opacityMap'))material.transparent=original.transparent||(typeof material.opacity==='number'&&material.opacity<1)||!!material.alphaMap;
      if(transformUV){
        for(const slot of ['map','roughnessMap','metalnessMap','alphaMap','bumpMap','normalMap','aoMap','transmissionMap','thicknessMap']){
          const source=material[slot];if(!(source instanceof THREE.Texture))continue;
          const group=slot==='map'||slot==='alphaMap'?'diffuse':slot==='normalMap'||slot==='bumpMap'?'normal':slot==='transmissionMap'||slot==='thicknessMap'?'transmissionThickness':'orm';
          const transform=overrides.mapTransforms?.[group];
          let copies=uvCopies.get(source);if(!copies){copies=new Map();uvCopies.set(source,copies);}let texture=copies.get(group);if(!texture){texture=source.clone();copies.set(group,texture);}
          texture.copy(source);texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.matrixAutoUpdate=true;
          // Source map transforms are direct repeats and take priority over the legacy global UI transform.
          texture.repeat.set(transform?transform.x:has('textureWidth')?1/Math.max(.01,overrides.textureWidth||1):source.repeat.x,transform?transform.y:has('textureHeight')?1/Math.max(.01,overrides.textureHeight||1):source.repeat.y);
          texture.center.copy(source.center);
          if(transform){texture.center.set(.5,.5);texture.rotation=THREE.MathUtils.degToRad(transform.rotation);}
          else if(has('textureRotation')){texture.center.set(.5,.5);texture.rotation=THREE.MathUtils.degToRad(overrides.textureRotation||0);}
          texture.needsUpdate=true;material[slot]=texture;
        }
      }
      copy.needsUpdate=true;materials.set(original,copy);
    }
    for(const binding of bindings)binding.mesh.material=Array.isArray(binding.original)?binding.original.map(material=>materials.get(material)!):materials.get(binding.original)!;
  };
  const restore=()=>{for(const binding of bindings)binding.mesh.material=binding.original;};
  const dispose=()=>{restore();standardCopies.forEach(material=>material.dispose());physicalCopies.forEach(material=>material.dispose());uvCopies.forEach(copies=>copies.forEach(texture=>texture.dispose()));};
  return {apply,restore,dispose};
}

function useOverrideMaps(overrides:Overrides|undefined){
  const key=JSON.stringify(mapKeys.map(name=>typeof overrides?.[name]==='string'?overrides[name]:null));
  const [state,setState]=useState<{key:string;maps:Partial<Record<MapKey,THREE.Texture>>;loading:boolean;error:string}>({key:'',maps:{},loading:false,error:''});
  const urls=JSON.parse(key) as (string|null)[];
  const hasMaps=urls.some(Boolean);
  useEffect(()=>{
    if(!hasMaps){setState({key,maps:{},loading:false,error:''});return;}
    let live=true;const owned=new Set<THREE.Texture>(),maps:Partial<Record<MapKey,THREE.Texture>>={};
    setState({key,maps:{},loading:true,error:''});
    Promise.all(mapKeys.map((name,index)=>!urls[index]?Promise.resolve():new Promise<void>((resolve,reject)=>{
      new THREE.TextureLoader().load(urls[index]!,texture=>{if(!live){texture.dispose();resolve();return;}owned.add(texture);texture.flipY=false;texture.wrapS=texture.wrapT=THREE.RepeatWrapping;if(name==='texture')texture.colorSpace=THREE.SRGBColorSpace;texture.needsUpdate=true;maps[name]=texture;resolve();},undefined,()=>reject(new Error('A material texture could not be loaded. Replace it or remove the override.')));
    }))).then(()=>{if(live)setState({key,maps,loading:false,error:''});}).catch(reason=>{if(live)setState({key,maps:{},loading:false,error:(reason as Error).message});});
    return()=>{live=false;owned.forEach(texture=>texture.dispose());};
  // The stable serialized URL list intentionally excludes numeric material edits.
  },[key,hasMaps]);
  return state.key===key?state:{key,maps:{},loading:hasMaps,error:''};
}

export default function ModelAsset({url,maxSize=1.5,onReady,onStatus,overrides,colorOverride,sourceMaterial=false}:Props){
  const [asset,setAsset]=useState<{url:string;scene:THREE.Group;unitPlacement:ReturnType<typeof modelPlacement>;materials:ReturnType<typeof createModelMaterialOverrides>}|null>(null),[loadError,setLoadError]=useState('');
  const invalidate=useThree(state=>state.invalidate),callbacks=useRef({onReady,onStatus}),notified=useRef<THREE.Object3D|null>(null);
  callbacks.current={onReady,onStatus};
  const textures=useOverrideMaps(overrides);
  const current=asset?.url===url?asset:null;
  const placement=useMemo(()=>{if(!current)return null;try{if(!Number.isFinite(maxSize)||maxSize<=0)throw new Error('This model has an invalid display size.');return {value:{scale:current.unitPlacement.scale*maxSize,offset:current.unitPlacement.offset.map(value=>value*maxSize) as [number,number,number]},error:''};}catch(reason){return {value:null,error:(reason as Error).message};}},[current,maxSize]);
  const error=loadError||placement?.error||textures.error;
  const status:Status=error?'error':!current||textures.loading?'loading':'ready';
  useEffect(()=>{
    let live=true,loaded:THREE.Group|undefined,materials:ReturnType<typeof createModelMaterialOverrides>|undefined;
    setAsset(null);setLoadError('');notified.current=null;
    const draco=new DRACOLoader().setDecoderPath('/draco/'),loader=new GLTFLoader().setDRACOLoader(draco);
    loader.load(url,gltf=>{
      loaded=gltf.scene;if(!live){disposeModel(loaded);return;}
      try{const unitPlacement=modelPlacement(loaded,1);loaded.traverse(node=>{if(node instanceof THREE.Mesh){node.castShadow=true;node.receiveShadow=true;}});materials=createModelMaterialOverrides(loaded,sourceMaterial);setAsset({url,scene:loaded,unitPlacement,materials});invalidate();}
      catch(reason){setLoadError((reason as Error).message);invalidate();}
    },undefined,()=>{if(live){setLoadError('This 3D file could not be opened. Check the model and try again.');invalidate();}});
    return()=>{live=false;draco.dispose();materials?.dispose();if(loaded)disposeModel(loaded);};
  },[url,invalidate,sourceMaterial]);
  useLayoutEffect(()=>{if(!current||textures.loading||textures.error)return;current.materials.apply(overrides,colorOverride,textures.maps);invalidate();},[current,overrides,colorOverride,textures.maps,textures.loading,textures.error,invalidate]);
  // The primitive and its normalization groups have committed before consumers fit the camera.
  useLayoutEffect(()=>{callbacks.current.onStatus?.(status);if(status==='ready'&&current&&notified.current!==current.scene){notified.current=current.scene;current.scene.updateWorldMatrix(true,true);callbacks.current.onReady?.(current.scene);}},[status,current]);
  return <>{current&&placement?.value&&<group position={placement.value.offset}><group scale={placement.value.scale}><primitive object={current.scene} dispose={null}/></group></group>}{status!=='ready'&&<Html center><div className="model-load-state" role={status==='error'?'alert':'status'}>{status==='error'?error:'Loading 3D model…'}</div></Html>}</>;
}
function disposeModel(scene:THREE.Object3D){
  const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>(),textures=new Set<THREE.Texture>();
  scene.traverse(object=>{if(object instanceof THREE.Mesh){geometries.add(object.geometry);for(const material of Array.isArray(object.material)?object.material:[object.material]){materials.add(material);for(const value of Object.values(material))if(value instanceof THREE.Texture)textures.add(value);}}});
  geometries.forEach(geometry=>geometry.dispose());materials.forEach(material=>material.dispose());const images=new Set<unknown>();textures.forEach(texture=>{texture.dispose();images.add(texture.image);});for(const image of images)if(typeof ImageBitmap!=='undefined'&&image instanceof ImageBitmap)image.close();
}
