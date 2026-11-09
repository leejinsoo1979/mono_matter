import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from 'react';
import { Canvas, useThree, type ThreeEvent } from '@react-three/fiber';
import { Environment, OrbitControls, TransformControls, RoundedBox } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { ArrowLeft, Box, Check, ChevronDown, ChevronRight, Copy, Download, Expand, Eye, EyeOff, Folder, Grid2X2, ImagePlus, Layers, Leaf, Lock, Magnet, Maximize, Minus, MousePointer2, Move, Plus, Redo2, RotateCw, Search, Share2, SlidersHorizontal, Sun, Trash2, Type, Undo2, Unlock, Upload, X } from 'lucide-react';
import type { Board, BoardEditorProps, BoardItem, BoardSettings, MaterialSettings, Product, Vec3 } from '../../shared/types';
import { defaultMaterial, uid } from '../../shared/defaults';
import './board.css';
import {brandPNG} from '../lib/export-branding';
import ModelAsset from './ModelAsset';
import SampleAsset from './SampleAsset';
import SceneReadiness from './SceneReadiness';
import {fitCamera} from '../lib/scene-math';

type Tool = 'select' | 'move' | 'rotate' | 'scale' | 'orbit';
type LibraryTab = 'products' | 'templates' | 'props';
type Template = { name: string; shape: BoardItem['shape']; category: string; color: string; kind?: BoardItem['kind'] };
const templates: Template[] = [
  { name: 'Square slab', shape: 'box', category: 'Surfaces', color: '#eee9e1' },
  { name: 'Rectangular slab', shape: 'plane', category: 'Tile', color: '#d8d1c5' },
  { name: 'Paint Blob', shape: 'blob', category: 'Paint', color: '#c5b79c' },
  { name: 'Round sample', shape: 'cylinder', category: 'Surfaces', color: '#e6dfd4' },
  { name: 'Triangular Plate', shape: 'triangle', category: 'Metal', color: '#a8a5a0' },
  { name: 'Hexagon Tile', shape: 'hexagon', category: 'Tile', color: '#e7e3db' },
  { name: 'Upholstery sample', shape: 'box', category: 'Textile', color: '#b6a68b' },
  { name: 'Lounge chair', shape: 'chair', category: 'Furniture', color: '#b4a28c', kind: 'furniture' },
  { name: 'Round table', shape: 'table', category: 'Furniture', color: '#9a795a', kind: 'furniture' },
];
const decorations: Template[] = [
  { name: 'Leaf stem', shape: 'plant', category: 'Plants', color: '#60704b', kind: 'prop' },
  { name: 'Natural stone', shape: 'sphere', category: 'Props', color: '#c1bba8', kind: 'prop' },
  { name: 'Brass ring', shape: 'cylinder', category: 'Props', color: '#b69b56', kind: 'prop' },
  { name: 'Small bowl', shape: 'blob', category: 'Props', color: '#cac4b8', kind: 'prop' },
];
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const rounded = (n: number) => Math.round(n * 1000) / 1000;
const radians = (n: number) => n * Math.PI / 180;
const degrees = (n: number) => rounded(n * 180 / Math.PI);
const bounded = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const fileName = (name: string) => name.replace(/[^\p{L}\p{N}_-]+/gu, '-');

function temperatureColor(kelvin: number) {
  const t = bounded(kelvin, 1000, 12000) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return new THREE.Color(bounded(r, 0, 255) / 255, bounded(g, 0, 255) / 255, bounded(b, 0, 255) / 255);
}

function useImageTexture(url: string | undefined, material: MaterialSettings, color = false) {
  const [texture, setTexture] = useState<THREE.Texture>();
  useEffect(() => {
    if (!url) { setTexture(undefined); return; }
    let live = true;
    let loaded: THREE.Texture | undefined;
    setTexture(undefined);
    new THREE.TextureLoader().load(url, value => {
      loaded = value;
      value.wrapS = value.wrapT = THREE.RepeatWrapping;
      if (color) value.colorSpace = THREE.SRGBColorSpace;
      if (live) setTexture(value); else value.dispose();
    }, undefined, () => { if (live) setTexture(undefined); });
    return () => { live = false; loaded?.dispose(); };
  }, [url, color]);
  useEffect(() => {
    if (!texture) return;
    texture.repeat.set(1 / Math.max(.01, material.textureWidth), 1 / Math.max(.01, material.textureHeight));
    texture.center.set(.5, .5);
    texture.rotation = radians(material.textureRotation);
    texture.needsUpdate = true;
  }, [texture, material.textureWidth, material.textureHeight, material.textureRotation]);
  return texture;
}

function Surface({ item }: { item: BoardItem }) {
  const m = item.material;
  const diffuse = useImageTexture(item.kind === 'image' ? item.image : m.texture, m, true);
  const roughnessMap = useImageTexture(m.roughnessMap, m);
  const opacityMap = useImageTexture(m.opacityMap, m);
  const bumpMap = useImageTexture(m.bumpMap, m);
  const normalMap = useImageTexture(m.normal ? m.normalMap : undefined, m);
  if (item.kind === 'text') return <TextSurface item={item} />;
  return <meshPhysicalMaterial userData={{assetStatus:((item.kind==='image'?item.image:m.texture)&&!diffuse)||(m.roughnessMap&&!roughnessMap)||(m.opacityMap&&!opacityMap)||(m.bumpMap&&!bumpMap)||(m.normal&&m.normalMap&&!normalMap)?'loading':'ready'}} color={item.kind === 'image' ? '#ffffff' : item.color} map={diffuse} roughness={m.roughness} metalness={m.metalness} ior={m.ior} opacity={m.opacity} transparent={m.opacity < 1 || !!opacityMap || item.kind === 'image'} transmission={m.transmission} thickness={m.thickness} attenuationDistance={m.distance <= 0 ? Infinity : m.distance} attenuationColor={m.attenuationColor} roughnessMap={roughnessMap} alphaMap={opacityMap} bumpMap={bumpMap} bumpScale={m.bumpScale} normalMap={normalMap} side={THREE.DoubleSide} />;
}

function TextSurface({ item }: { item: BoardItem }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1536; canvas.height = 384;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = '500 100px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = item.color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lines = (item.text || item.name).split('\n');
    lines.forEach((line, i) => ctx.fillText(line, canvas.width / 2, canvas.height / 2 + (i - (lines.length - 1) / 2) * 110, 1460));
    const result = new THREE.CanvasTexture(canvas); result.colorSpace = THREE.SRGBColorSpace;
    return result;
  }, [item.text, item.name, item.color]);
  useEffect(() => () => texture.dispose(), [texture]);
  return <meshBasicMaterial map={texture} transparent side={THREE.DoubleSide} depthWrite={false} />;
}

function ProfileGeometry({ shape }: { shape: BoardItem['shape'] }) {
  const geometry = useMemo(() => {
    const outline = new THREE.Shape();
    const sides = shape === 'triangle' ? 3 : shape === 'hexagon' ? 6 : 32;
    for (let i = 0; i <= sides; i++) {
      const angle = i / sides * Math.PI * 2 + Math.PI / 2;
      const radius = shape === 'blob' ? .48 + Math.sin(angle * 3) * .055 + Math.cos(angle * 5) * .03 : .58;
      const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
      if (i === 0) outline.moveTo(x, y); else outline.lineTo(x, y);
    }
    const result = new THREE.ExtrudeGeometry(outline, { depth: .065, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: .01, bevelThickness: .01 });
    result.rotateX(-Math.PI / 2); result.translate(0, .02, 0);
    return result;
  }, [shape]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <primitive object={geometry} attach="geometry" />;
}

function effectiveMaterial(item:BoardItem,product?:Product):MaterialSettings{
  if(!product?.material)return {...item.material,...item.materialOverrides};
  const defaults=defaultMaterial(),legacy:Partial<MaterialSettings>={};
  if(!item.materialOverrides){
    for(const [key,value] of Object.entries(item.material)){
      if(key==='texture'&&typeof value==='string'&&value.startsWith('/assets/')&&!value.startsWith('/assets/api-')&&!product.custom)continue;
      if(JSON.stringify(value)!==JSON.stringify(defaults[key as keyof MaterialSettings]))Object.assign(legacy,{[key]:value});
    }
  }
  return {...defaults,...product.material,...legacy,...item.materialOverrides};
}

function ItemBody({ item, product, onModelReady, onModelStatus }: { item: BoardItem; product?:Product; onModelReady?:()=>void; onModelStatus?:(id:string,url:string,status:'loading'|'ready'|'error')=>void }) {
  const material=effectiveMaterial(item,product);
  const reportStatus=useCallback((status:'loading'|'ready'|'error')=>onModelStatus?.(item.id,product?.model||'',status),[item.id,product?.model,onModelStatus]);
  const surface = <Surface item={{...item,material}} />;
  if(product?.sampleKind&&product.sampleKind!=='model'&&!product.model)return <SampleAsset product={{...product,color:item.color,material,texture:material.texture||product.texture}} maxSize={product.modelSize?Math.max(...product.modelSize)*5:1.5}/>;
  if(product?.model)return <ModelAsset url={product.model} sourceMaterial={product.sampleKind==='model'} maxSize={product.modelSize?Math.max(...product.modelSize)*5:1.5} onReady={onModelReady} onStatus={reportStatus} overrides={product.material?material:item.materialOverrides} colorOverride={item.colorOverride?item.color:undefined}/>;
  if(product && product.type!=='Material' && !product.shape)return <mesh rotation={[-Math.PI/2,0,0]} position={[0,.05,0]}><planeGeometry args={[1.5,1.5]}/><ReferenceSurface url={product.image}/></mesh>;
  if (item.kind === 'text' || item.kind === 'image') return <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .045, 0]}><planeGeometry args={item.kind === 'text' ? [2, .5] : [1.5, 1.5]} />{surface}</mesh>;
  if (item.shape === 'chair') return <group>
    <RoundedBox castShadow receiveShadow position={[0, .48, 0]} args={[.8,.18,.78]} radius={.065} smoothness={4}>{surface}</RoundedBox>
    <RoundedBox castShadow receiveShadow position={[0,.86,-.31]} rotation={[-.12,0,0]} args={[.8,.68,.17]} radius={.065} smoothness={4}>{surface}</RoundedBox>
    {[-.42,.42].map(x=><RoundedBox key={x} castShadow receiveShadow position={[x,.64,-.03]} args={[.11,.2,.7]} radius={.045} smoothness={4}>{surface}</RoundedBox>)}
    {[-.28, .28].flatMap(x => [-.28, .28].map(z => <mesh key={`${x}-${z}`} castShadow position={[x, .23, z]}><cylinderGeometry args={[.028, .022, .46, 10]} /><meshStandardMaterial color="#423f39" /></mesh>))}
  </group>;
  if (item.shape === 'table') return <group><mesh castShadow receiveShadow position={[0, .8, 0]}><cylinderGeometry args={[.65, .65, .07, 48]} />{surface}</mesh><mesh castShadow position={[0, .4, 0]}><cylinderGeometry args={[.08, .1, .8, 24]} />{surface}</mesh><mesh castShadow position={[0, .03, 0]}><cylinderGeometry args={[.34, .38, .05, 32]} />{surface}</mesh></group>;
  if (item.shape === 'plant') return <group rotation={[.1, 0, -.4]}>
    <mesh castShadow position={[0, .035, 0]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[.015, .018, 2.2, 8]} /><meshStandardMaterial color="#657a48" roughness={.8} /></mesh>
    {Array.from({ length: 8 }, (_, i) => <mesh key={i} castShadow position={[(i % 2 ? 1 : -1) * .15, .055, -.9 + i * .25]} rotation={[-Math.PI / 2, 0, (i % 2 ? 1 : -1) * .6]} scale={[.13, .29, .025]}><sphereGeometry args={[1, 12, 8]} />{surface}</mesh>)}
  </group>;
  const ring = item.shape === 'cylinder' && item.kind === 'prop';
  return <mesh castShadow receiveShadow rotation={ring ? [-Math.PI / 2, 0, 0] : [0, 0, 0]} position={item.shape === 'sphere' ? [0, .32, 0] : [0, .04, 0]}>
    {item.shape === 'sphere' ? <sphereGeometry args={[.32, 32, 24]} /> : ring ? <torusGeometry args={[.35, .035, 14, 48]} /> : item.shape === 'cylinder' ? <cylinderGeometry args={[.5, .5, .075, 48]} /> : ['triangle', 'hexagon', 'blob'].includes(item.shape) ? <ProfileGeometry shape={item.shape} /> : <boxGeometry args={item.shape === 'plane' ? [1, .045, 1.45] : [1, .09, 1]} />}
    {surface}
  </mesh>;
}

function ReferenceSurface({url}:{url:string}){
  const m=useMemo(defaultMaterial,[]),texture=useImageTexture(url,m,true);
  return <meshBasicMaterial map={texture} color="#ffffff" side={THREE.DoubleSide}/>;
}

type SceneItemProps = { item: BoardItem; product?:Product; onModelReady?:()=>void; onModelStatus?:(id:string,url:string,status:'loading'|'ready'|'error')=>void; selected: boolean; tool: Tool; readOnly: boolean; onSelect: (id: string) => void; onPreview: (id: string, patch: Partial<BoardItem>) => void; onBegin: () => void; onEnd: () => void; onDrag: (dragging: boolean) => void; snap: boolean };
function SceneItem({ item, product, onModelReady, onModelStatus, selected, tool, readOnly, onSelect, onPreview, onBegin, onEnd, onDrag, snap }: SceneItemProps) {
  const group = useRef<THREE.Group>(null);
  const drag = useRef<{ offset: THREE.Vector3; plane: THREE.Plane; startX: number; startY: number } | null>(null);
  const pointerDown = (e: ThreeEvent<PointerEvent>) => {
    if(tool==='orbit')return;
    e.stopPropagation(); onSelect(item.id);
    if (readOnly || item.locked || !['select', 'move'].includes(tool) || e.button !== 0) return;
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -item.position[1]);
    const hit = e.ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return;
    drag.current = { plane, offset: new THREE.Vector3(...item.position).sub(hit), startX: e.clientX, startY: e.clientY };
    onBegin(); onDrag(true);
    (e.target as unknown as { setPointerCapture?: (id: number) => void }).setPointerCapture?.(e.pointerId);
  };
  const pointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!drag.current) return;
    e.stopPropagation();
    if (Math.abs(e.clientX - drag.current.startX) + Math.abs(e.clientY - drag.current.startY) < 3) return;
    const hit = e.ray.intersectPlane(drag.current.plane, new THREE.Vector3());
    if (!hit) return;
    hit.add(drag.current.offset);
    const unit = snap ? .1 : .001;
    onPreview(item.id, { position: [Math.round(hit.x / unit) * unit, item.position[1], Math.round(hit.z / unit) * unit] });
  };
  const pointerUp = (e: ThreeEvent<PointerEvent>) => {
    if (!drag.current) return;
    e.stopPropagation(); drag.current = null; onDrag(false); onEnd();
    (e.target as unknown as { releasePointerCapture?: (id: number) => void }).releasePointerCapture?.(e.pointerId);
  };
  return <>
    <group ref={group} name={`board-item-${item.id}`} userData={{ boardItemId: item.id, kind: item.kind }} position={item.position} rotation={item.rotation} scale={item.scale} visible={item.visible} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}>
      <ItemBody item={item} product={product} onModelReady={onModelReady} onModelStatus={onModelStatus}/>
      {selected && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .013, 0]}><ringGeometry args={[.74, .753, 64]} /><meshBasicMaterial color={item.locked ? '#cf9c3b' : '#315deb'} transparent opacity={.9} depthTest={false} /></mesh>}
    </group>
    {selected && !readOnly && !item.locked && (tool === 'rotate' || tool === 'scale') && <TransformControls object={group as React.RefObject<THREE.Object3D>} mode={tool} size={.8} rotationSnap={snap ? Math.PI / 12 : null} scaleSnap={snap ? .1 : null} onMouseDown={() => { onBegin(); onDrag(true); }} onObjectChange={() => {
      if (!group.current) return;
      onPreview(item.id, { position: group.current.position.toArray() as Vec3, rotation: [group.current.rotation.x, group.current.rotation.y, group.current.rotation.z], scale: group.current.scale.toArray() as Vec3 });
    }} onMouseUp={() => { onDrag(false); onEnd(); }} />}
  </>;
}

type ExportRenderer = (width: number) => Promise<string>;
type DropProjector = (x: number, y: number) => Vec3 | undefined;
function SceneController({ settings, recenter, zoom, modelsReady, registerExport, registerProjector }: { settings: BoardSettings; recenter: number; zoom: number; modelsReady:number; registerExport: (fn: ExportRenderer) => void; registerProjector: (fn: DropProjector) => void }) {
  const { camera, gl, scene, invalidate, controls, size } = useThree();
  useEffect(() => {
    const bounds=new THREE.Box3();
    scene.traverse(o=>{if(o.name.startsWith('board-item-')&&o.visible)bounds.expandByObject(o);});
    if(camera instanceof THREE.PerspectiveCamera){const target=fitCamera(camera,bounds,settings.view,size.width/size.height);const orbit=controls as OrbitControlsImpl|undefined;if(orbit){orbit.target.copy(target);orbit.update();}}
    invalidate();
  }, [camera, settings.view, recenter, modelsReady, controls, size.width, size.height, scene, invalidate]);
  useEffect(() => { camera.zoom = zoom; camera.updateProjectionMatrix(); invalidate(); }, [camera, zoom, invalidate]);
  useEffect(() => { registerProjector((x, y) => { const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(x, y), camera); const point = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3()); return point ? point.toArray() as Vec3 : undefined; }); }, [camera, registerProjector]);
  useEffect(() => { registerExport(async width => {
    let pending=false;scene.traverseVisible(o=>{if(o.userData.assetStatus&&o.userData.assetStatus!=='ready')pending=true;if(o instanceof THREE.Mesh)for(const m of Array.isArray(o.material)?o.material:[o.material])if(m.userData.assetStatus&&m.userData.assetStatus!=='ready')pending=true;});if(pending)throw new Error('Some textures are still loading or unavailable.');
    const old = gl.getSize(new THREE.Vector2());
    const ratio = gl.getPixelRatio();
    const height = Math.round(width * old.y / old.x);
    try {
      gl.setPixelRatio(1); gl.setSize(width, height, false); gl.render(scene, camera);
      return gl.domElement.toDataURL('image/png');
    } finally { gl.setPixelRatio(ratio); gl.setSize(old.x, old.y, false); invalidate(); }
  }); }, [camera, gl, scene, invalidate, registerExport]);
  return null;
}

function BackgroundImage({ url }: { url: string }) {
  const material = useMemo(defaultMaterial, []);
  const texture = useImageTexture(url, material, true);
  return texture ? <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -.027, 0]}><planeGeometry args={[20, 15]} /><meshBasicMaterial map={texture} /></mesh> : null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="board-field"><span>{label}</span>{children}</label>; }
function Slider({ label, value, min = 0, max = 1, step = .01, onChange, disabled }: { label: string; value: number; min?: number; max?: number; step?: number; onChange: (value: number) => void; disabled?: boolean }) {
  return <label className="board-slider"><span>{label}</span><input aria-label={label} type="range" min={min} max={max} step={step} value={Number.isFinite(value) ? value : min} onChange={e => onChange(Number(e.target.value))} disabled={disabled} /><input aria-label={`${label} value`} type="number" min={min} max={max} step={step} value={rounded(value)} onChange={e => onChange(bounded(Number(e.target.value), min, max))} disabled={disabled} /></label>;
}

export default function BoardEditor(props: BoardEditorProps) {
  const { products, onBack, onShare, onSaveProduct, projectName = 'My project', readOnly = false, watermark = true } = props;
  const [board, setBoard] = useState<Board>(() => clone(props.board));
  const current = useRef(board);
  const lastSent = useRef(props.board);
  const ownPublishedSnapshots = useRef<string[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [libraryTab, setLibraryTab] = useState<LibraryTab>('products');
  const [panelTab, setPanelTab] = useState<'details' | 'material'>('details');
  const [specName, setSpecName] = useState('');
  const [specValue, setSpecValue] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [brand, setBrand] = useState('All');
  const [productType, setProductType] = useState('All');
  const [filters, setFilters] = useState(false);
  const [tool, setTool] = useState<Tool>('select');
  const [dragging, setDragging] = useState(false);
  const [recenter, setRecenter] = useState(0);
  const [modelsReady,setModelsReady]=useState(0);
  const [sceneReady,setSceneReady]=useState(false);
  const markSceneReady=useCallback(()=>setSceneReady(true),[]);
  const [modelStatuses,setModelStatuses]=useState<Record<string,{url:string;status:'loading'|'ready'|'error'}>>({});
  const reportModelStatus=useCallback((id:string,url:string,status:'loading'|'ready'|'error')=>setModelStatuses(prev=>prev[id]?.url===url&&prev[id]?.status===status?prev:{...prev,[id]:{url,status}}),[]);
  const modelReady=useCallback(()=>setModelsReady(n=>n+1),[]);
  const [zoom, setZoom] = useState(1);
  const [cameraView, setCameraView] = useState<BoardSettings['view']>(props.board.settings.view);
  const [snap, setSnap] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);
  const [drawerFallback, setDrawerFallback] = useState<string[]>([]);
  const [toast, setToast] = useState('');
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportSize, setExportSize] = useState(2400);
  const [exportOpen, setExportOpen] = useState(false);
  const [lastExport,setLastExport]=useState<{image:string;downloadUrl:string;name:string}|null>(null);
  useEffect(()=>()=>{if(lastExport)URL.revokeObjectURL(lastExport.downloadUrl);},[lastExport]);
  const [historyTick, setHistoryTick] = useState(0);
  const [remoteGeneration, setRemoteGeneration] = useState(0);
  const undoStack = useRef<Board[]>([]), redoStack = useRef<Board[]>([]);
  const gestureStart = useRef<Board | null>(null);
  const renderExport = useRef<ExportRenderer | undefined>(undefined);
  const projectDrop = useRef<DropProjector | undefined>(undefined);
  const sceneContainer = useRef<HTMLDivElement>(null);
  const uploadTarget = useRef<string>('image');
  const fileInput = useRef<HTMLInputElement>(null);
  const selectedItem = board.items.find(item => item.id === selectedId);
  const selected = selectedItem?{...selectedItem,material:effectiveMaterial(selectedItem,products.find(p=>p.id===selectedItem.productId))}:undefined;
  const selectedProduct = products.find(product => product.id === selected?.productId);
  const selectedSpecs = selected?.specs ?? selectedProduct?.specs ?? {};
  const drawer = props.drawer ?? drawerFallback;
  const onChangeRef = useRef(props.onChange); onChangeRef.current = props.onChange;
  const notify = (message: string) => setToast(message);
  useEffect(() => { if (!toast) return; const timeout = window.setTimeout(() => setToast(''), 3600); return () => window.clearTimeout(timeout); }, [toast]);
  useEffect(() => {
    if (props.board === lastSent.current) return;
    const incoming = JSON.stringify(props.board);
    // Workspace saves clone our own payload. Keep local undo for those echoes,
    // including a delayed acknowledgement of an earlier local publication.
    if (incoming === JSON.stringify(lastSent.current) || ownPublishedSnapshots.current.includes(incoming)) {
      lastSent.current = props.board;
      return;
    }
    // A foreign snapshot becomes the new undo boundary. A whole-board undo
    // made before this boundary would otherwise remove collaborators' work.
    undoStack.current = []; redoStack.current = []; gestureStart.current = null;
    ownPublishedSnapshots.current = [];
    setDragging(false); setHistoryTick(t => t + 1); setRemoteGeneration(t => t + 1);
    if (props.board.id !== current.current.id) setSelectedId(undefined);
    const next = clone(props.board); current.current = next; setBoard(next); setCameraView(next.settings.view); lastSent.current = props.board;
  }, [props.board]);

  const publish = useCallback((next: Board, record = true, origin?: Board) => {
    if (readOnly) return;
    const previous = origin ?? current.current;
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    if (record) { undoStack.current = [...undoStack.current, clone(previous)].slice(-80); redoStack.current = []; }
    const value = { ...next, updatedAt: new Date().toISOString() };
    ownPublishedSnapshots.current = [...ownPublishedSnapshots.current, JSON.stringify(value)].slice(-40);
    current.current = value; lastSent.current = value; setBoard(value); setCameraView(value.settings.view); onChangeRef.current(value); setHistoryTick(t => t + 1);
  }, [readOnly]);
  const updateItem = useCallback((id: string, patch: Partial<BoardItem>) => {
    const source = current.current;
    publish({ ...source, items: source.items.map(item => item.id === id ? { ...item, ...patch,...('color' in patch?{colorOverride:patch.colorOverride??true}:{}) } : item) });
  }, [publish]);
  const previewItem = useCallback((id: string, patch: Partial<BoardItem>) => {
    const value = { ...current.current, items: current.current.items.map(item => item.id === id ? { ...item, ...patch } : item) };
    current.current = value; setBoard(value);
  }, []);
  const beginGesture = useCallback(() => { if (!gestureStart.current) gestureStart.current = clone(current.current); }, []);
  const endGesture = useCallback(() => { const start = gestureStart.current; gestureStart.current = null; if (start) publish(current.current, true, start); }, [publish]);
  const migratedBoard=useRef('');
  useEffect(()=>{if(migratedBoard.current===props.board.id||readOnly)return;migratedBoard.current=props.board.id;
    if(current.current.items.some(i=>i.productId&&i.canvas?.type==='product'&&i.kind==='furniture'&&i.scale[0]===1&&i.scale[1]===.12&&i.scale[2]===1))publish({...current.current,items:current.current.items.map(i=>i.productId&&i.canvas?.type==='product'&&i.kind==='furniture'&&i.scale[0]===1&&i.scale[1]===.12&&i.scale[2]===1?{...i,scale:[1,1,1] as Vec3}:i)});
  },[props.board.id,publish,readOnly]);

  const setSettings = (patch: Partial<BoardSettings>) => { if (patch.view) setCameraView(patch.view); publish({ ...current.current, settings: { ...current.current.settings, ...patch } }); };
  const setMaterial = (patch: Partial<MaterialSettings>) => { if(selected){if(selected.material.mapTransforms&&['textureWidth','textureHeight','textureRotation'].some(k=>k in patch)){patch={...patch,mapTransforms:Object.fromEntries(Object.entries(selected.material.mapTransforms).map(([k,t])=>[k,t?{x:t.x*(patch.textureWidth!==undefined?selected.material.textureWidth/patch.textureWidth:1),y:t.y*(patch.textureHeight!==undefined?selected.material.textureHeight/patch.textureHeight:1),rotation:t.rotation+(patch.textureRotation!==undefined?patch.textureRotation-selected.material.textureRotation:0)}:t]))};}const saved=Object.fromEntries(Object.entries(patch).map(([k,v])=>[k,v===undefined?'':v]));updateItem(selected.id,{material:{...selected.material,...patch},materialOverrides:{...selected.materialOverrides,...saved}});} };
  const updateDrawer = (ids: string[]) => { if (readOnly) return; if (props.onDrawerChange) props.onDrawerChange(ids); else setDrawerFallback(ids); };
  const addToDrawer = (productId: string) => { if (!drawer.includes(productId)) updateDrawer([...drawer, productId]); setDrawerOpen(true); };
  const addItem = useCallback((value: Partial<BoardItem> & Pick<BoardItem, 'name' | 'shape'>, position?: Vec3) => {
    if (readOnly) return;
    const source = current.current;
    const item: BoardItem = { id: uid(), kind: 'material', color: '#ded5c6', rotation: [0, 0, 0], scale: [1, 1, 1], locked: false, visible: true, material: defaultMaterial(), ...value, position: position ?? value.position ?? [(source.items.length % 4 - 1.5) * 1.15, .02 + source.items.length * .002, Math.floor(source.items.length / 4) * 1.15 - .5] };
    publish({ ...source, items: [...source.items, item] }); setSelectedId(item.id); setPanelTab('details');
  }, [publish, readOnly]);
  const addProduct = (product: Product, position?: Vec3) => {
    const furniture = /furniture|chair|table|sofa|bed/i.test(`${product.type} ${product.category}`);
    const shape: BoardItem['shape'] = product.shape ?? (furniture ? /table/i.test(product.category + product.name) ? 'table' : 'chair' : /stone|tile/i.test(product.category) ? 'plane' : 'box');
    addItem({ name: product.name, shape, kind: furniture ? 'furniture' : product.category === 'Props' ? 'prop' : 'material', productId: product.id, brand: product.brand, specs: clone(product.specs), notes: product.custom ? product.description : undefined, image: product.image, color: product.color || '#d4c4ac', material: { ...defaultMaterial(), texture: furniture ? product.texture : product.texture || product.image, roughness: /metal/i.test(product.category) ? .28 : .65, metalness: /metal/i.test(product.category) ? .82 : 0, ...product.material } }, position);
  };
  const removeSelected = useCallback(() => {
    const source = current.current, item = source.items.find(i => i.id === selectedId);
    if (!item || item.locked || readOnly) return;
    publish({ ...source, items: source.items.filter(i => i.id !== selectedId) }); setSelectedId(undefined);
  }, [publish, readOnly, selectedId]);
  const duplicateSelected = useCallback(() => {
    const item = current.current.items.find(i => i.id === selectedId);
    if (!item || readOnly) return;
    addItem({ ...clone(item), id: uid(), name: `${item.name} copy`, locked: false }, [item.position[0] + .2, item.position[1] + .01, item.position[2] + .2]);
  }, [addItem, readOnly, selectedId]);
  const undo = useCallback(() => {
    if (!undoStack.current.length || readOnly) return;
    redoStack.current.push(clone(current.current));
    const next = undoStack.current.pop()!; publish(next, false);
  }, [publish, readOnly]);
  const redo = useCallback(() => {
    if (!redoStack.current.length || readOnly) return;
    undoStack.current.push(clone(current.current));
    const next = redoStack.current.pop()!; publish(next, false);
  }, [publish, readOnly]);
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open],[aria-modal="true"]')) return;
      const target = e.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') { setSelectedId(undefined); setSettingsOpen(false); setExportOpen(false); return; }
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); }
      else if (!mod && ['v', 'g', 'r', 's', 'o'].includes(e.key.toLowerCase())) setTool(({ v: 'select', g: 'move', r: 'rotate', s: 'scale', o: 'orbit' } as Record<string, Tool>)[e.key.toLowerCase()]);
      else if (!mod && e.key.toLowerCase() === 'l' && selectedId && !readOnly) { const item = current.current.items.find(i => i.id === selectedId); if (item) updateItem(item.id, { locked: !item.locked }); }
      else if (!mod && e.key === 'Home') { e.preventDefault(); setRecenter(n => n + 1); setZoom(1); }
      else if (!mod && e.key.toLowerCase() === 't' && !readOnly) addItem({ name: 'Text', shape: 'plane', kind: 'text', text: 'Your material story', color: '#333333' });
      else if (selectedId && !readOnly && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        const item = current.current.items.find(i => i.id === selectedId); if (!item || item.locked) return;
        e.preventDefault(); const position = [...item.position] as Vec3, step = e.shiftKey ? .1 : .01;
        if (e.key === 'ArrowLeft') position[0] -= step; if (e.key === 'ArrowRight') position[0] += step; if (e.key === 'ArrowUp') position[2] -= step; if (e.key === 'ArrowDown') position[2] += step;
        updateItem(item.id, { position });
      }
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, [addItem, duplicateSelected, readOnly, redo, removeSelected, selectedId, undo, updateItem]);

  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file || readOnly) return;
    if (!file.type.startsWith('image/')) { notify('Choose an image file.'); return; }
    const target = uploadTarget.current, itemId = selectedId;
    setUploading(true);
    try {
      const data = new FormData(); data.append('file', file);
      const response = await fetch('/api/upload', { method: 'POST', body: data });
      const result = await response.json() as { url?: string; error?: string };
      if (!response.ok || !result.url) throw new Error(result.error || 'Upload failed');
      if (target === 'image') addItem({ name: file.name, shape: 'plane', kind: 'image', image: result.url, color: '#ffffff' });
      else if (target === 'background') setSettings({ backgroundImage: result.url });
      else if (itemId) { const item = current.current.items.find(i => i.id === itemId); if (item) updateItem(itemId, { material: { ...item.material, [target]: result.url },materialOverrides:{...item.materialOverrides,[target]:result.url} }); }
      notify('Image uploaded.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Unable to upload image.'); }
    finally { setUploading(false); }
  };
  const requestUpload = (target: string) => { uploadTarget.current = target; fileInput.current?.click(); };
  const exportPNG = async () => {
    if (!renderExport.current) { notify('The 3D scene is still loading.'); return; }
    if(board.items.some(i=>{const url=products.find(p=>p.id===i.productId)?.model;return i.visible&&url&&(modelStatuses[i.id]?.url!==url||modelStatuses[i.id]?.status!=='ready');})){notify('Wait for all visible 3D models and textures to load before exporting.');return;}
    setExporting(true);
    try {
      setSelectedId(undefined);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const url = await brandPNG(await renderExport.current(exportSize), watermark);
      const name=`${fileName(board.name)}-${exportSize}px.png`;
      const downloadUrl=URL.createObjectURL(await (await fetch(url)).blob());
      setLastExport({image:url,downloadUrl,name});
      const link = document.createElement('a'); link.href = downloadUrl; link.download = name;document.body.appendChild(link);link.click();link.remove();setExportOpen(false);notify('PNG ready. You can preview or download it again from Export.');
    } catch { notify('Export failed. Check that all image textures have finished loading.'); }
    finally { setExporting(false); }
  };
  const saveCustomProduct = () => {
    if (!selected || !onSaveProduct) return;
    const item = selected;
    const product: Product = { id: selectedProduct?.custom ? selectedProduct.id : uid(), name: item.name, brand: item.brand || selectedProduct?.brand || 'My studio', category: item.kind === 'prop' ? 'Props' : 'Custom material', type: item.kind === 'furniture' ? 'Furniture' : 'Material', image: item.material.texture || item.image || selectedProduct?.image || '', texture: item.material.texture, color: item.color, price: selectedProduct?.price || 0, description: item.notes || 'Custom material created in the board editor.', specs: { ...selectedSpecs }, variants: [{ name: 'Custom finish', color: item.color }], custom: true, model:selectedProduct?.model, sampleKind:selectedProduct?.sampleKind, modelSize:selectedProduct?.modelSize, images:selectedProduct?.images, files:selectedProduct?.files, material: clone(item.material), shape: item.shape };
    onSaveProduct(product); updateItem(item.id, { productId: product.id }); notify('Saved to your product library.');
  };
  const applyFinish = (variant:Product['variants'][number]) => {
    if(!selected)return;
    const sku=products.find(product=>product.id===variant.productId);
    if(sku){
      // A catalog finish is another SKU with its own model and PBR channels.
      const overrides=selectedItem?.materialOverrides||{};
      updateItem(selected.id,{productId:sku.id,name:sku.name,brand:sku.brand,image:sku.image,color:sku.color,colorOverride:false,specs:clone(sku.specs),material:{...defaultMaterial(),...sku.material,...overrides},materialOverrides:overrides});
    }else{
      const texture=variant.image||selectedProduct?.texture||selectedProduct?.image;
      updateItem(selected.id,{color:variant.color,material:{...selected.material,texture},materialOverrides:{...selected.materialOverrides,texture}});
    }
  };
  const categories = ['All', ...new Set(products.map(product => product.category))];
  const visibleProducts = products.filter(product => (category === 'All' || product.category === category) && (brand === 'All' || product.brand === brand) && (productType === 'All' || product.type.toLowerCase() === productType.toLowerCase()) && `${product.name} ${product.brand} ${product.category}`.toLowerCase().includes(search.toLowerCase()));
  const filteredTemplates = (libraryTab === 'props' ? decorations : templates).filter(t => `${t.name} ${t.category}`.toLowerCase().includes(search.toLowerCase()));
  const canEdit = !readOnly && !!selected && !selected.locked;
  const registerExport = useCallback((fn: ExportRenderer) => { renderExport.current = fn; }, []);
  const registerProjector = useCallback((fn: DropProjector) => { projectDrop.current = fn; }, []);
  const drop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault(); if (readOnly) return;
    const raw = event.dataTransfer.getData('application/monogram'); if (!raw) return;
    try {
      const data = JSON.parse(raw) as { productId?: string; template?: Template };
      const rect = event.currentTarget.getBoundingClientRect();
      const hit = projectDrop.current?.(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      const position: Vec3 | undefined = hit ? [hit[0], .04 + board.items.length * .002, hit[2]] : undefined;
      if (data.productId) { const product = products.find(p => p.id === data.productId); if (product) addProduct(product, position); }
      else if (data.template) addItem(data.template, position);
    } catch { notify('Unable to add this item.'); }
  };

  return <div className="board-editor" data-board-id={board.id} data-item-count={board.items.length} data-selected-id={selectedId ?? ''} data-history={historyTick}>
    <input ref={fileInput} className="board-hidden" type="file" accept="image/*" onChange={upload} />
    <header className="board-header">
      <button className="board-brand" onClick={onBack} title="Back to monogram project"><ArrowLeft size={17} /><span className="board-logo-window"><img src="/brand/monogram.png" alt="monogram" /></span></button>
      <div className="board-library-tabs">
        <button className={libraryTab === 'products' ? 'active' : ''} onClick={() => { setLibraryTab('products'); setSearch(''); setCategory('All'); }} title="Product library"><Layers size={18} /></button>
        <button className={libraryTab === 'templates' ? 'active' : ''} onClick={() => { setLibraryTab('templates'); setSearch(''); setCategory('All'); }} title="Model templates"><Box size={18} /></button>
        <button className={libraryTab === 'props' ? 'active' : ''} onClick={() => { setLibraryTab('props'); setSearch(''); setCategory('All'); }} title="Decorations"><Leaf size={18} /></button>
      </div>
      <div className="board-breadcrumb"><span>{projectName}</span><i>/</i><input aria-label="Board name" value={board.name} disabled={readOnly} onChange={event => publish({ ...current.current, name: event.target.value })} /></div>
      <div className="board-header-actions"><span className="board-save-state">{readOnly ? 'View only' : 'Workspace autosave'}</span><button onClick={() => setExportOpen(!exportOpen)} title="Export PNG"><Download size={16} /><span>Export</span></button><button className="board-share" onClick={onShare}><Share2 size={15} /> Share</button></div>
    </header>

    <aside className="board-library">
      <div className="board-library-search"><Search size={15} /><input aria-label="Search board library" placeholder={libraryTab === 'products' ? 'Search materials & products' : 'Search models'} value={search} onChange={e => setSearch(e.target.value)} /><button className={filters ? 'active' : ''} onClick={() => setFilters(!filters)} aria-label="Filter library"><SlidersHorizontal size={16} /></button></div>
      <div className="board-chips">{(libraryTab === 'products' ? categories.slice(0, 8) : ['All', ...(libraryTab === 'props' ? ['Plants', 'Props'] : ['Surfaces', 'Tile', 'Paint', 'Metal'])]).map(value => <button key={value} className={category === value ? 'active' : ''} onClick={() => { setCategory(value); if (libraryTab !== 'products') setSearch(value === 'All' ? '' : value); }}>{value}{value === 'All' && <ChevronDown size={11} />}</button>)}</div>
      {filters && <div className="board-filter-panel"><div className="board-section-heading">Refine products<button onClick={() => { setCategory('All'); setBrand('All'); setProductType('All'); setSearch(''); }}>Clear all</button></div><Field label="Product type"><select value={productType} onChange={e => setProductType(e.target.value)}><option>All</option>{[...new Set(products.map(p => p.type))].map(value => <option key={value}>{value}</option>)}</select></Field><Field label="Category"><select value={category} onChange={e => setCategory(e.target.value)}>{categories.map(value => <option key={value}>{value}</option>)}</select></Field><Field label="Brand"><select value={brand} onChange={e => setBrand(e.target.value)}><option>All</option>{[...new Set(products.map(p => p.brand))].sort().map(value => <option key={value}>{value}</option>)}</select></Field></div>}
      <div className="board-library-label"><span>{libraryTab === 'products' ? 'PRODUCT LIBRARY' : libraryTab === 'templates' ? 'MODEL TEMPLATES' : 'DECORATIONS'}</span><span>{libraryTab === 'products' ? visibleProducts.length : filteredTemplates.length}</span></div>
      <div className="board-cards">
        {libraryTab === 'products' ? visibleProducts.map(product => <button key={product.id} className="board-card" draggable={!readOnly} onDragStart={e => { e.dataTransfer.setData('application/monogram', JSON.stringify({ productId: product.id })); e.dataTransfer.effectAllowed = 'copy'; }} onClick={() => addProduct(product)} disabled={readOnly}><div className="board-card-image" style={{ backgroundColor: product.color || '#ece8df' }}>{product.image && <img src={product.image} alt="" loading="lazy" />}<span>{product.category}</span><i><Plus size={14} /></i></div><strong>{product.name}</strong><small>{product.brand}</small></button>) : filteredTemplates.map(template => <button key={template.name} className="board-card" draggable={!readOnly} onDragStart={e => e.dataTransfer.setData('application/monogram', JSON.stringify({ template }))} onClick={() => addItem(template)} disabled={readOnly}><div className={`board-card-image board-template-image board-shape-${template.shape}`} style={{ '--sample-color': template.color } as React.CSSProperties}><span className="board-template-shape">{template.shape === 'plant' ? '⌁' : template.shape === 'chair' ? '▱' : template.shape === 'table' ? '⊤' : ''}</span><span>{template.category}</span><i><Plus size={14} /></i></div><strong>{template.name}</strong><small>Parametric model</small></button>)}
        {libraryTab === 'products' && !visibleProducts.length && <div className="board-library-empty"><Search size={24} /><p>No products found</p><button onClick={() => { setSearch(''); setCategory('All'); setBrand('All'); setProductType('All'); }}>Clear filters</button></div>}
      </div>
      <div className="board-library-footer"><span>Drag to canvas or click to add</span><button disabled={readOnly || uploading} onClick={() => requestUpload('image')}><ImagePlus size={16} /> Upload image</button></div>
    </aside>

    <main className="board-canvas-area" ref={sceneContainer} onDragOver={e => { if (!readOnly) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }} onDrop={drop}>
      <div className="board-canvas-top"><label className="board-render-toggle"><span className={board.settings.interactive ? 'board-status-dot' : 'board-status-dot paused'} />Interactive rendering<input type="checkbox" checked={board.settings.interactive} disabled={readOnly} onChange={e => setSettings({ interactive: e.target.checked })} /><span className="board-switch" /></label><div className="board-history"><button onClick={undo} disabled={readOnly || !undoStack.current.length} title="Undo (⌘Z)"><Undo2 size={16} /></button><button onClick={redo} disabled={readOnly || !redoStack.current.length} title="Redo (⇧⌘Z)"><Redo2 size={16} /></button></div></div>
      <Canvas shadows dpr={[1, 2]} frameloop={board.settings.interactive ? 'always' : 'demand'} camera={{ position: [0, 8, .001], fov: 50, near: .01, far: 150 }} gl={{ antialias: true, preserveDrawingBuffer: true, alpha: false }} onPointerMissed={() => setSelectedId(undefined)}>
        <color attach="background" args={[board.settings.background]} />
        <ambientLight intensity={board.settings.lightIntensity * .45} />
        <hemisphereLight args={['#ffffff', '#81776a', board.settings.lightIntensity * .3]} />
        <directionalLight position={[-3, 7, 4]} intensity={board.settings.lightIntensity * 1.5} color={temperatureColor(board.settings.temperature)} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-10} shadow-camera-right={10} shadow-camera-top={10} shadow-camera-bottom={-10} shadow-normalBias={.025} />
        <Environment files="/environments/studio.hdr" environmentIntensity={.65}/>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -.03, 0]} receiveShadow><planeGeometry args={[200, 200]} /><meshStandardMaterial color={board.settings.background} roughness={.95} /></mesh>
        <Suspense fallback={null}>{board.settings.backgroundImage && <BackgroundImage url={board.settings.backgroundImage} />}{board.items.map(item => <SceneItem key={`${item.id}:${remoteGeneration}`} item={item} product={products.find(p=>p.id===item.productId)} onModelReady={modelReady} onModelStatus={reportModelStatus} selected={item.id === selectedId} tool={tool} readOnly={readOnly} onSelect={setSelectedId} onPreview={previewItem} onBegin={beginGesture} onEnd={endGesture} onDrag={setDragging} snap={snap} />)}</Suspense>
        {board.settings.grid && <gridHelper args={[24, 48, '#a29e98', '#cfcbc4']} position={[0, -.005, 0]} />}
        <OrbitControls key={`${cameraView}-${recenter}`} makeDefault enabled={!dragging} enableDamping dampingFactor={.1} minDistance={.3} maxDistance={150} minPolarAngle={.001} maxPolarAngle={Math.PI / 2 - .02} mouseButtons={{ LEFT: tool==='orbit'?THREE.MOUSE.ROTATE:THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }} />
        <SceneController settings={{ ...board.settings, view: cameraView }} recenter={recenter} zoom={zoom} modelsReady={modelsReady} registerExport={registerExport} registerProjector={registerProjector} />
      <SceneReadiness onReady={markSceneReady}/></Canvas>
      {!sceneReady&&<div className="board-scene-loading" role="status">Opening 3D scene…</div>}
      {!board.items.length && <div className="board-empty-canvas"><div className="board-empty-symbol"><Layers size={25} /></div><h2>A new material story</h2><p>Bring your palette together.<br />Drag samples from the library to begin.</p><span>Materials · textures · objects · ideas</span></div>}
      <div className="board-canvas-tools">
        {([{ value: 'select', Icon: MousePointer2, label: 'Select & drag (V)' }, { value: 'move', Icon: Move, label: 'Move (G)' }, { value: 'rotate', Icon: RotateCw, label: 'Rotate (R)' }, { value: 'scale', Icon: Expand, label: 'Scale (S)' }] as const).map(({ value, Icon, label }) => <button className={tool === value ? 'active' : ''} onClick={() => setTool(value)} title={label} key={value} disabled={readOnly}><Icon size={17} /></button>)}
        <button className={tool==='orbit'?'active':''} onClick={()=>setTool('orbit')} title="Orbit view (O)"><RotateCw size={17}/></button>
        <span />
        <button onClick={() => { setRecenter(n => n + 1); setZoom(1); setSettings({ view: 'top' }); }} title="Recenter · top view (Home)"><Maximize size={17} /></button>
        <button className={board.settings.grid ? 'active' : ''} onClick={() => setSettings({ grid: !board.settings.grid })} disabled={readOnly} title="Toggle grid"><Grid2X2 size={17} /></button>
        <button className={snap ? 'active' : ''} onClick={() => setSnap(!snap)} disabled={readOnly} title="Snap to grid · 0.1 units"><Magnet size={17} /></button>
        <button className={settingsOpen ? 'active' : ''} onClick={() => setSettingsOpen(!settingsOpen)} title="Lighting & background"><Sun size={18} /></button>
        <button onClick={() => addItem({ name: 'Text', shape: 'plane', kind: 'text', text: 'Your material story', color: '#333333' })} disabled={readOnly} title="Add text (T)"><Type size={18} /></button>
        <button className={layersOpen ? 'active' : ''} onClick={() => setLayersOpen(!layersOpen)} title="Object layers"><Layers size={17} /></button>
      </div>
      <div className="board-view-controls"><button onClick={() => setSettings({ view: cameraView === 'top' ? 'perspective' : 'top' })} title="Toggle perspective"><Box size={15} /><span>{cameraView === 'top' ? 'Top view' : 'Perspective'}</span></button><span /><button onClick={() => setZoom(z => Math.max(.3, z - .15))} title="Zoom out"><Minus size={15} /></button><span className="board-zoom-label">{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(z => Math.min(3, z + .15))} title="Zoom in"><Plus size={15} /></button></div>
      <button className={`board-drawer-toggle ${drawerOpen ? 'active' : ''}`} onClick={() => setDrawerOpen(!drawerOpen)}><Folder size={14} />Project Drawer<span>{drawer.length}</span><ChevronDown size={13} /></button>
      <div className="board-canvas-hint">Drag objects to move · Right drag to orbit · Scroll to zoom</div>
      {selected && <div className="board-selection-actions"><span>{selected.name}</span><button disabled={readOnly} onClick={() => updateItem(selected.id, { locked: !selected.locked })} title={selected.locked ? 'Unlock (L)' : 'Lock (L)'}>{selected.locked ? <Lock size={14} /> : <Unlock size={14} />}</button><button disabled={readOnly} onClick={duplicateSelected} title="Duplicate (⌘D)"><Copy size={14} /></button><button disabled={!canEdit} onClick={removeSelected} title="Delete"><Trash2 size={14} /></button></div>}
      {layersOpen && <div className="board-layers-popover"><div className="board-section-heading">Layers · {board.items.length}<button onClick={() => setLayersOpen(false)} aria-label="Close object layers"><X size={14} /></button></div>{board.items.length ? [...board.items].reverse().map(item => <div className={item.id === selectedId ? 'active' : ''} key={item.id}><button onClick={() => setSelectedId(item.id)}><Box size={13} /><span>{item.name}</span></button><button disabled={readOnly} onClick={() => updateItem(item.id, { visible: !item.visible })} title={item.visible ? 'Hide object' : 'Show object'}>{item.visible ? <Eye size={13} /> : <EyeOff size={13} />}</button><button disabled={readOnly} onClick={() => updateItem(item.id, { locked: !item.locked })} title={item.locked ? 'Unlock object' : 'Lock object'}>{item.locked ? <Lock size={12} /> : <Unlock size={12} />}</button></div>) : <p>No objects on the board.</p>}</div>}
      {settingsOpen && <div className="board-settings-popover"><div className="board-section-heading">Scene settings<button onClick={() => setSettingsOpen(false)} aria-label="Close scene settings"><X size={15} /></button></div><Slider label="Light intensity" value={board.settings.lightIntensity} min={0} max={6} step={.1} disabled={readOnly} onChange={value => setSettings({ lightIntensity: value })} /><Slider label="Temperature" value={board.settings.temperature} min={2000} max={10000} step={100} disabled={readOnly} onChange={value => setSettings({ temperature: value })} /><Field label="Background"><input type="color" value={board.settings.background} disabled={readOnly} onChange={e => setSettings({ background: e.target.value })} /></Field><button className="board-outline-button" disabled={readOnly || uploading} onClick={() => requestUpload('background')}><Upload size={14} /> Add background image</button>{board.settings.backgroundImage && <button className="board-link-button" disabled={readOnly} onClick={() => setSettings({ backgroundImage: undefined })}>Remove background image</button>}<p>Light temperature is measured in Kelvin.</p></div>}
      {drawerOpen && <div className="board-drawer"><div className="board-section-heading"><span>Project Drawer · {drawer.length}</span><button onClick={() => setDrawerOpen(false)} aria-label="Close project drawer"><X size={16} /></button></div>{drawer.length ? <div className="board-drawer-products">{drawer.map(id => { const product = products.find(p => p.id === id); return product && <div key={id}><button onClick={() => addProduct(product)} disabled={readOnly}>{product.image ? <img src={product.image} alt="" /> : <i className="board-drawer-swatch" style={{ backgroundColor: product.color }} />}<span>{product.name}<small>{product.brand}</small></span><Plus size={15} /></button><button disabled={readOnly} onClick={() => updateDrawer(drawer.filter(value => value !== id))} title="Remove from drawer"><X size={12} /></button></div>; })}</div> : <p>Keep your shortlisted products here. Select a product and choose “Add to drawer”.</p>}</div>}
    </main>

    <aside className="board-details">
      <div className="board-detail-tabs"><button className={panelTab === 'details' ? 'active' : ''} onClick={() => setPanelTab('details')}>Details</button><button className={panelTab === 'material' ? 'active' : ''} onClick={() => setPanelTab('material')}>Material</button><button title="monogram AI requires a connected provider" onClick={() => notify('monogram AI is not connected. AI generation is unavailable in this workspace.')} className="board-ai-label">monogram AI<small>Not connected</small></button></div>
      {!selected ? <div className="board-detail-empty"><MousePointer2 size={24} /><p>Select a sample to explore<br />its material and details.</p><div><span>{board.items.length}</span>objects on this board</div></div> : panelTab === 'details' ? <div className="board-detail-content">
        <div className="board-selected-preview" style={{ backgroundColor: selected.color }}><span>{selectedProduct?.image || selected.image || selected.material.texture ? <img src={selectedProduct?.image || selected.image || selected.material.texture} alt={selected.name} /> : <Box size={50} strokeWidth={.8} />}</span><i>{selectedProduct?.category || selected.kind}</i><button title="Focus selected object" onClick={() => setZoom(1.4)}><Maximize size={15} /></button></div>
        <input className="board-item-name" aria-label="Object name" value={selected.name} disabled={!canEdit} onChange={e => updateItem(selected.id, { name: e.target.value })} />
        <input className="board-product-brand board-brand-input" aria-label="Brand name" value={selected.brand ?? selectedProduct?.brand ?? 'My studio'} disabled={!canEdit} onChange={e => updateItem(selected.id, { brand: e.target.value })} />
        <p className="board-model-note">{selected.kind === 'image' ? 'Reference image on a flat 3D surface.' : selected.kind === 'text' ? 'Editable text rendered locally.' : selectedProduct?.model ? '3D model · drag the scene to inspect every side.' : selectedProduct && selectedProduct.type !== 'Material' && !selectedProduct.shape ? 'Image reference · no 3D model has been added for this product.' : 'Parametric material or template geometry.'}</p>
        {selectedProduct && selectedProduct.variants.length > 0 && <section className="board-detail-section"><div className="board-section-heading">Color & finish<span>{selectedProduct.variants.length} options</span></div><div className="board-variants">{selectedProduct.variants.map(variant => <button key={variant.productId||variant.name} title={variant.name} aria-label={`Apply finish ${variant.name}`} className={(variant.productId?selected.productId===variant.productId:selected.color===variant.color) ? 'active' : ''} disabled={!canEdit} style={{ backgroundColor: variant.color }} onClick={() => applyFinish(variant)}>{(variant.productId?selected.productId===variant.productId:selected.color===variant.color) && <Check size={15} />}</button>)}</div></section>}
        <div className="board-detail-buttons">{selected.productId && <button className="board-dark-button" disabled={readOnly || drawer.includes(selected.productId)} onClick={() => addToDrawer(selected.productId!)}><Plus size={14} />{drawer.includes(selected.productId) ? 'In drawer' : 'Add to drawer'}</button>}{onSaveProduct && selected.kind !== 'text' && selected.kind !== 'image' && <button className="board-dark-button" disabled={!canEdit} onClick={saveCustomProduct}><Folder size={14} />{selectedProduct?.custom ? 'Update library' : 'Save to library'}</button>}<button className="board-outline-button" onClick={duplicateSelected} disabled={readOnly}><Copy size={14} />Duplicate</button></div>
        {selected.kind === 'text' && <section className="board-detail-section"><Field label="Text"><textarea value={selected.text || ''} disabled={!canEdit} onChange={e => updateItem(selected.id, { text: e.target.value })} rows={3} /></Field></section>}
        <section className="board-detail-section"><div className="board-section-heading">Transform<span>Scene units</span></div>{(['position', 'rotation', 'scale'] as const).map(key => <div className="board-transform-field" key={key}><label>{key === 'rotation' ? 'Rotation °' : key.charAt(0).toUpperCase() + key.slice(1)}</label><div>{selected[key].map((value, index) => <label key={index}><span>{['X', 'Y', 'Z'][index]}</span><input type="number" aria-label={`${key} ${['X', 'Y', 'Z'][index]}`} step={key === 'rotation' ? 5 : .05} min={key === 'scale' ? .05 : undefined} disabled={!canEdit} value={key === 'rotation' ? degrees(value) : rounded(value)} onChange={event => { const values = [...selected[key]] as Vec3; const n = Number(event.target.value); values[index] = key === 'rotation' ? radians(n) : key === 'scale' ? Math.max(.05, n) : n; updateItem(selected.id, { [key]: values }); }} /></label>)}</div></div>)}<div className="board-object-toggles"><label><input type="checkbox" checked={selected.locked} disabled={readOnly} onChange={e => updateItem(selected.id, { locked: e.target.checked })} />Lock object</label><label><input type="checkbox" checked={selected.visible} disabled={readOnly} onChange={e => updateItem(selected.id, { visible: e.target.checked })} />Visible</label></div></section>
        <section className="board-detail-section"><div className="board-section-heading">Technical specification</div>{Object.entries(selectedSpecs).map(([name, value]) => <div className="board-spec board-editable-spec" key={name}><strong>{name}</strong><input aria-label={`Specification ${name}`} disabled={!canEdit} value={value} onChange={event => updateItem(selected.id, { specs: { ...selectedSpecs, [name]: event.target.value } })} /><button disabled={!canEdit} title={`Remove specification ${name}`} onClick={() => { const next = { ...selectedSpecs }; delete next[name]; updateItem(selected.id, { specs: next }); }}><X size={11} /></button></div>)}{!Object.keys(selectedSpecs).length && <p className="board-muted">Add dimensions, certifications or material notes.</p>}{!readOnly && <div className="board-add-spec"><input aria-label="New specification name" placeholder="Attribute" value={specName} disabled={!canEdit} onChange={e => setSpecName(e.target.value)} /><input aria-label="New specification value" placeholder="Value" value={specValue} disabled={!canEdit} onChange={e => setSpecValue(e.target.value)} /><button title="Add specification" disabled={!canEdit || !specName.trim()} onClick={() => { updateItem(selected.id, { specs: { ...selectedSpecs, [specName.trim()]: specValue } }); setSpecName(''); setSpecValue(''); }}><Plus size={14} /></button></div>}{selectedProduct?.sourceUrl && <a className="board-source-link" href={selectedProduct.sourceUrl} target="_blank" rel="noreferrer">View original product <ChevronRight size={13} /></a>}{selectedProduct?.files?.map(file => <a className="board-source-link" key={file.url} href={file.url} target="_blank" rel="noreferrer"><Download size={13} />{file.name}</a>)}</section>
        <section className="board-detail-section"><Field label="Additional information"><textarea aria-label="Additional information" value={selected.notes || ''} disabled={!canEdit} onChange={e => updateItem(selected.id, { notes: e.target.value })} placeholder="Add a note for your team…" rows={3} /></Field></section>
        {selectedProduct?.description && <section className="board-detail-section"><div className="board-section-heading">Product story</div><p className="board-description">{selectedProduct.description}</p></section>}
        <button className="board-delete-button" disabled={!canEdit} onClick={removeSelected}><Trash2 size={14} />Delete object</button>
      </div> : <div className="board-detail-content board-material-editor">
        <Field label="Base color"><div className="board-color-control"><input type="color" value={selected.color} disabled={!canEdit} onChange={e => updateItem(selected.id, { color: e.target.value })} /><input aria-label="Color hex" value={selected.color} disabled={!canEdit} onChange={e => { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) updateItem(selected.id, { color: e.target.value }); }} /></div></Field>
        {([{ key: 'texture', label: 'Diffuse Map' }, { key: 'roughnessMap', label: 'Roughness Map' }, { key: 'opacityMap', label: 'Opacity Map' }, { key: 'bumpMap', label: 'Bump Map' }, { key: 'normalMap', label: 'Normal Map' }] as const).map(({ key, label }) => <div className="board-map-field" key={key}><div className="board-section-heading">{label}{selected.material[key] && <button disabled={!canEdit} onClick={() => setMaterial({ [key]: undefined })} title={`Remove ${label}`}><X size={12} /></button>}</div><button className="board-texture-upload" disabled={!canEdit || uploading} onClick={() => requestUpload(key)}>{selected.material[key] ? <><img src={selected.material[key]} alt="" /><span>Replace texture</span></> : <><Upload size={13} /><span>Add texture</span></>}</button></div>)}
        <div className="board-section-heading">Texture mapping<span>All maps</span></div><div className="board-map-transform">{(['textureWidth', 'textureHeight', 'textureRotation'] as const).map((key, index) => <Field key={key} label={['Width', 'Height', 'Rotation °'][index]}><input type="number" step={index === 2 ? 5 : .1} min={index === 2 ? undefined : .01} disabled={!canEdit} value={selected.material[key]} onChange={e => setMaterial({ [key]: index === 2 ? Number(e.target.value) : Math.max(.01, Number(e.target.value)) })} /></Field>)}</div>
        <div className="board-material-divider" />
        <Slider label="Roughness" value={selected.material.roughness} onChange={value => setMaterial({ roughness: value })} disabled={!canEdit} />
        <Slider label="Metalness" value={selected.material.metalness} onChange={value => setMaterial({ metalness: value })} disabled={!canEdit} />
        <Slider label="IOR" value={selected.material.ior} min={1} max={2.333} step={.01} onChange={value => setMaterial({ ior: value })} disabled={!canEdit} />
        <Slider label="Opacity" value={selected.material.opacity} onChange={value => setMaterial({ opacity: value })} disabled={!canEdit} />
        <Slider label="Transmission" value={selected.material.transmission} onChange={value => setMaterial({ transmission: value })} disabled={!canEdit} />
        <Slider label="Thickness" value={selected.material.thickness} max={5} step={.01} onChange={value => setMaterial({ thickness: value })} disabled={!canEdit} />
        <Slider label="Distance" value={selected.material.distance} min={0} max={20} step={.1} onChange={value => setMaterial({ distance: value })} disabled={!canEdit} />
        <Field label="Attenuation color"><input type="color" value={selected.material.attenuationColor} disabled={!canEdit} onChange={e => setMaterial({ attenuationColor: e.target.value })} /></Field>
        <label className="board-check-field"><span>Normal map</span><input type="checkbox" checked={selected.material.normal} disabled={!canEdit} onChange={e => setMaterial({ normal: e.target.checked })} /></label>
        <Slider label="Bump depth" value={selected.material.bumpScale} min={-.5} max={.5} step={.005} onChange={value => setMaterial({ bumpScale: value })} disabled={!canEdit} />
        <button className="board-outline-button" disabled={!canEdit} onClick={() => setMaterial(defaultMaterial())}><RotateCw size={13} />Reset material properties</button>
        <p className="board-material-help">Maps use the same scale and rotation. Roughness, bump and normal detail become visible when their texture maps are added. Distance 0 means infinite attenuation distance.</p>
      </div>}
    </aside>
    {exportOpen && <div className="board-export-popover"><div className="board-section-heading">Export your board<button onClick={() => setExportOpen(false)} aria-label="Close export"><X size={15} /></button></div><p>Download the current camera view as a PNG image.</p>{watermark&&<p className="muted">Free and Starter exports include monogram branding. Plus and Studio exports are unbranded.</p>}<Field label="Image width"><select value={exportSize} onChange={e => setExportSize(Number(e.target.value))}><option value={1200}>1,200 px</option><option value={2400}>2,400 px</option><option value={3600}>3,600 px</option><option value={4800}>4,800 px</option></select></Field><button className="board-dark-button" onClick={exportPNG} disabled={exporting}>{exporting ? 'Rendering…' : <><Download size={14} />Download PNG</>}</button>{lastExport&&<div className="board-export-result"><span>Last exported image</span><img src={lastExport.image} alt="Exported board preview"/><a href={lastExport.downloadUrl} download={lastExport.name}><Download size={13}/>Download again</a></div>}</div>}
    {(toast || uploading) && <div className="board-toast" role="status">{uploading ? 'Uploading image…' : toast}</div>}
  </div>;
}
