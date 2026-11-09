import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createModelMaterialOverrides} from '../src/components/ModelAsset.tsx';

function fixture(){
  const map=new THREE.Texture();map.repeat.set(2,3);map.center.set(.1,.2);map.rotation=.4;
  const material=new THREE.MeshStandardMaterial({color:'#445566',roughness:.7,metalness:.2,map});
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(),[material,material]),scene=new THREE.Group();scene.add(mesh);
  const overrides=createModelMaterialOverrides(scene);
  const current=()=>mesh.material[0] as THREE.MeshPhysicalMaterial;
  return {map,material,mesh,overrides,current};
}

test('untouched imports retain original material identity and embedded GLB texture settings',()=>{
  const f=fixture();f.overrides.apply();assert.equal(f.current(),f.material);assert.equal(f.mesh.material[1],f.material);assert.equal(f.material.map,f.map);assert.deepEqual(f.map.repeat.toArray(),[2,3]);assert.equal(f.map.rotation,.4);f.overrides.dispose();
});

test('external source PBR config overrides a reused geometry material without changing its baseline',()=>{
  const f=fixture();
  f.overrides.apply({color:'#112233',roughness:.15,metalness:.8,ior:1.8,transmission:.6,thickness:.7,distance:3,attenuationColor:'#abcdef',sheen:.5,sheenColor:'#fedcba',sheenRoughness:.2,clearcoat:.9,clearcoatRoughness:.1,specularIntensity:.4,aoMapIntensity:.6});
  const material=f.current();assert.ok(material.isMeshPhysicalMaterial);assert.equal(material.color.getHexString(),'112233');assert.equal(material.roughness,.15);assert.equal(material.metalness,.8);assert.equal(material.ior,1.8);assert.equal(material.transmission,.6);assert.equal(material.thickness,.7);assert.equal(material.attenuationDistance,3);assert.equal(material.attenuationColor.getHexString(),'abcdef');assert.equal(material.sheen,.5);assert.equal(material.sheenColor.getHexString(),'fedcba');assert.equal(material.sheenRoughness,.2);assert.equal(material.clearcoat,.9);assert.equal(material.clearcoatRoughness,.1);assert.equal(material.specularIntensity,.4);assert.equal(material.aoMapIntensity,.6);
  assert.equal(f.material.color.getHexString(),'445566');assert.equal(f.material.roughness,.7);assert.equal(f.mesh.material[0],f.mesh.material[1]);
  f.overrides.apply({});assert.equal(f.current(),f.material);assert.equal(f.material.map,f.map);f.overrides.dispose();
});

test('manual color overrides source color, then reverts to source and embedded colors independently',()=>{
  const f=fixture();f.overrides.apply({color:'#123456'},'#ff0000');assert.equal(f.current().color.getHexString(),'ff0000');f.overrides.apply({color:'#123456'});assert.equal(f.current().color.getHexString(),'123456');f.overrides.apply({});assert.equal(f.current().color.getHexString(),'445566');f.overrides.dispose();
});

test('per-map direct repeats and degree rotations remain isolated even when maps share the same texture',()=>{
  const f=fixture();f.material.normalMap=f.map;
  f.overrides.apply({textureWidth:100,textureHeight:100,textureRotation:90,mapTransforms:{diffuse:{x:4,y:5,rotation:60},normal:{x:6,y:7,rotation:45}}});
  const material=f.current();assert.deepEqual(material.map!.repeat.toArray(),[4,5]);assert.deepEqual(material.normalMap!.repeat.toArray(),[6,7]);assert.equal(material.map!.rotation,Math.PI/3);assert.equal(material.normalMap!.rotation,Math.PI/4);assert.notEqual(material.map,material.normalMap);assert.deepEqual(f.map.repeat.toArray(),[2,3]);assert.equal(f.map.rotation,.4);
  f.overrides.apply({textureWidth:4});assert.deepEqual(f.current().map!.repeat.toArray(),[.25,3]);assert.equal(f.current().map!.rotation,.4);f.overrides.apply({});assert.equal(f.current().map,f.map);assert.equal(f.current().normalMap,f.map);f.overrides.dispose();
});

test('combined ORM maps affect correct channels, and explicit clears and opacity edits are reversible',()=>{
  const f=fixture(),orm=new THREE.Texture(),normal=new THREE.Texture(),roughness=new THREE.Texture();
  f.overrides.apply({ormMap:'/assets/orm.png',normalMap:'/assets/normal.png',normal:true,normalScale:.5,opacity:.3},undefined,{ormMap:orm,normalMap:normal});
  const current=f.current();assert.equal(current.roughnessMap,orm);assert.equal(current.metalnessMap,orm);assert.equal(current.aoMap,orm);assert.equal(current.normalMap,normal);assert.deepEqual(current.normalScale.toArray(),[.5,.5]);assert.equal(current.transparent,true);
  f.overrides.apply({ormMap:'/assets/orm.png',roughnessMap:'/assets/roughness.png'},undefined,{ormMap:orm,roughnessMap:roughness});assert.equal(f.current().roughnessMap,roughness);assert.equal(f.current().metalnessMap,orm);assert.equal(f.current().aoMap,orm);
  f.overrides.apply({texture:undefined,normal:false});assert.equal(f.current().map,null);assert.equal(f.current().normalMap,null);f.overrides.apply({});assert.equal(f.current(),f.material);assert.equal(f.material.map,f.map);assert.equal(f.material.opacity,1);assert.equal(f.material.transparent,false);f.overrides.dispose();
});

test('an unlit GLB accepts explicit physical edits and controller cleanup leaves owned originals intact',()=>{
  const original=new THREE.MeshBasicMaterial({color:'#123456'}),mesh=new THREE.Mesh(new THREE.BoxGeometry(),original),controller=createModelMaterialOverrides(mesh);
  let originalsDisposed=0;original.addEventListener('dispose',()=>originalsDisposed++);
  controller.apply({roughness:.4});const working=mesh.material as unknown as THREE.MeshPhysicalMaterial;assert.equal(working.isMeshPhysicalMaterial,true);assert.equal(working.roughness,.4);assert.equal(working.color.getHexString(),'123456');let copiesDisposed=0;working.addEventListener('dispose',()=>copiesDisposed++);
  controller.dispose();assert.equal(mesh.material,original);assert.equal(originalsDisposed,0);assert.equal(copiesDisposed,1);
});

test('catalog template target receives source PBR without black placeholder tint; back keeps its embedded finish',()=>{
 const target=new THREE.MeshStandardMaterial({color:'#000000',metalness:1});target.name='target';
 const back=new THREE.MeshStandardMaterial({color:'#999999',roughness:.8});back.name='back.001';
 const mesh=new THREE.Mesh(new THREE.BoxGeometry(),[back,target]),scene=new THREE.Group();scene.add(mesh);
 const controller=createModelMaterialOverrides(scene,true),texture=new THREE.Texture();controller.apply({texture:'/assets/texture.webp',roughness:.1,metalness:.5},undefined,{texture});
 const materials=mesh.material as THREE.Material[];assert.equal(materials[0],back);const applied=materials[1] as THREE.MeshPhysicalMaterial;
 assert.equal(applied.color.getHexString(),'ffffff');assert.equal(applied.map,texture);assert.equal(applied.roughness,.1);assert.equal(applied.metalness,.5);controller.dispose();
});
