import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {modelPlacement,fitCamera} from '../src/lib/scene-math.ts';

test('import normalization preserves all proportions, nested transforms, centers XZ and grounds Y',()=>{
  const scene=new THREE.Group();scene.position.set(1200,-400,700);scene.scale.setScalar(.001);
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(800,600,700));mesh.position.set(300,900,-500);scene.add(mesh);
  const placement=modelPlacement(scene,1.5),group=new THREE.Group();group.position.fromArray(placement.offset);
  const uniform=new THREE.Group();uniform.scale.setScalar(placement.scale);uniform.add(scene);group.add(uniform);
  group.updateWorldMatrix(true,true);const bounds=new THREE.Box3().setFromObject(group),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
  assert.ok(Math.abs(Math.max(size.x,size.y,size.z)-1.5)<1e-9);
  assert.ok(Math.abs(size.x/size.y-800/600)<1e-9);
  assert.ok(Math.abs(size.z/size.y-700/600)<1e-9);
  assert.ok(Math.abs(bounds.min.y)<1e-9);assert.ok(Math.abs(center.x)<1e-9);assert.ok(Math.abs(center.z)<1e-9);
});
test('camera fitting retains Y-up and contains off-center objects in landscape and portrait',()=>{
  const box=new THREE.Box3(new THREE.Vector3(200,0,-70),new THREE.Vector3(220,6,-30));
  for(const aspect of [.4,1,2.5])for(const view of ['top','perspective'] as const){
    const camera=new THREE.PerspectiveCamera(40,aspect,.01,100);
    const target=fitCamera(camera,box,view,aspect);camera.updateMatrixWorld(true);
    assert.deepEqual(camera.up.toArray(),[0,1,0]);assert.ok(target.equals(box.getCenter(new THREE.Vector3())));
    for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]){
      const ndc=new THREE.Vector3(x,y,z).project(camera);assert.ok(Math.abs(ndc.x)<=1&&Math.abs(ndc.y)<=1&&Math.abs(ndc.z)<=1,JSON.stringify({aspect,view,ndc}));
    }
  }
});
test('invalid or empty models fail explicitly instead of dividing by zero',()=>{
  assert.throws(()=>modelPlacement(new THREE.Group()),/no visible geometry/);
  assert.throws(()=>modelPlacement(new THREE.Mesh(new THREE.BoxGeometry(0,0,0))),/invalid dimensions/);
});
