import * as THREE from 'three';

/** Fit arbitrary import units without flattening any axis, and place its base on y=0. */
export function modelPlacement(object:THREE.Object3D, maxSize=1.5){
  object.updateWorldMatrix(true,true);
  const bounds=new THREE.Box3().setFromObject(object);
  if(bounds.isEmpty())throw new Error('This model contains no visible geometry.');
  const size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
  const extent=Math.max(size.x,size.y,size.z);
  if(!Number.isFinite(extent)||extent<=0)throw new Error('This model has invalid dimensions.');
  const scale=maxSize/extent;
  return {scale,offset:[-center.x*scale,-bounds.min.y*scale,-center.z*scale] as [number,number,number],size:size.multiplyScalar(scale)};
}

export function fitCamera(camera:THREE.PerspectiveCamera,bounds:THREE.Box3,view:'top'|'perspective',aspect:number){
  const box=bounds.isEmpty()?new THREE.Box3(new THREE.Vector3(-1,0,-1),new THREE.Vector3(1,1,1)):bounds;
  const center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3());
  const halfFov=THREE.MathUtils.degToRad(camera.fov/2),horizontalHalfFov=Math.atan(Math.tan(halfFov)*Math.max(aspect,.1));
  const distance=Math.max(size.length()/2,.6)/Math.sin(Math.min(halfFov,horizontalHalfFov))*1.15;
  const direction=view==='top'?new THREE.Vector3(0,1,.0001):new THREE.Vector3(1,.8,1).normalize();
  camera.up.set(0,1,0);
  camera.position.copy(center).addScaledVector(direction,Math.max(distance,2));
  camera.near=Math.max(.001,distance/1000);camera.far=Math.max(100,distance*100);
  camera.lookAt(center);camera.updateProjectionMatrix();
  return center;
}
