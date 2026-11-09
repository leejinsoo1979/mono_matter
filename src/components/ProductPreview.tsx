import {Suspense,useState,useEffect,useRef,useCallback} from 'react';
import {Canvas,useThree} from '@react-three/fiber';
import {OrbitControls,ContactShadows,Environment} from '@react-three/drei';
import type {OrbitControls as OrbitControlsImpl} from 'three-stdlib';
import * as THREE from 'three';
import type {Product} from '../../shared/types';
import ModelAsset from './ModelAsset';
import SampleAsset from './SampleAsset';
import SceneReadiness from './SceneReadiness';
import {fitCamera} from '../lib/scene-math';
function InspectorCamera({reset,ready,resourceKey,controls}:{reset:number;ready:number;resourceKey:string;controls:React.RefObject<OrbitControlsImpl|null>}){
 const {camera,scene,size,invalidate}=useThree();
 useEffect(()=>{const model=scene.getObjectByName('inspected-model');if(!model||!(camera instanceof THREE.PerspectiveCamera))return;
 const center=fitCamera(camera,new THREE.Box3().setFromObject(model),'perspective',size.width/size.height);
 if(controls.current){controls.current.target.copy(center);controls.current.update();}invalidate();
 },[camera,scene,size.width,size.height,reset,ready,resourceKey,controls,invalidate]);return null;
}
export default function ProductPreview({product,onAttachModel}:{product:Product;onAttachModel?:()=>void}){
 const [reset,setReset]=useState(0),[ready,setReady]=useState(0),[sceneReady,setSceneReady]=useState(false);const markReady=useCallback(()=>setSceneReady(true),[]);const controls=useRef<OrbitControlsImpl>(null);
 const isMaterial=product.type==='Material'||product.sampleKind==='alpha-plane'||product.sampleKind==='box';
 if(!product.model&&!isMaterial)return <div className="product-3d unavailable-model"><img src={product.image} alt={product.name}/><div className="missing-model-note"><strong>3D model not available</strong><p>This product has a reference image. Add its GLB file to inspect the actual shape from every angle.</p>{onAttachModel&&<button className="pill" onClick={onAttachModel}>Add a 3D model</button>}</div></div>;
 return <div className="product-3d"><Canvas shadows dpr={[1,2]} camera={{position:[3,2.4,3],fov:40,near:.01,far:100}} gl={{antialias:true}}><color attach="background" args={['#f4f4f2']}/><ambientLight intensity={.6}/><directionalLight castShadow position={[3,6,4]} intensity={2} shadow-mapSize={[2048,2048]} shadow-normalBias={.015} shadow-bias={-.0001}/><Environment files="/environments/studio.hdr" environmentIntensity={.65}/><group name="inspected-model"><Suspense fallback={null}>{product.model?<ModelAsset url={product.model} sourceMaterial={product.sampleKind==='model'} overrides={product.material} onReady={()=>setReady(n=>n+1)}/>:<SampleAsset product={product}/>}</Suspense></group><ContactShadows position={[0,-.005,0]} opacity={.3} scale={7} blur={2.5}/><OrbitControls ref={controls} makeDefault target={[0,.65,0]} enableDamping dampingFactor={.1} minDistance={.3} maxDistance={20} minPolarAngle={.03} maxPolarAngle={Math.PI/2-.02}/><InspectorCamera reset={reset} ready={ready} resourceKey={`${product.id}:${product.model}:${product.sampleKind}:${product.modelSize}`} controls={controls}/><SceneReadiness onReady={markReady}/></Canvas>{!sceneReady&&<div className="board-scene-loading" role="status">Opening 3D scene…</div>}<button className="pill preview-reset" onClick={()=>setReset(n=>n+1)}>Reset view</button><span className="preview-hint">Drag to rotate · Scroll to zoom{!product.model?product.sampleKind==='alpha-plane'?' · Flat image sample':' · Material sample':''}</span></div>;
}
