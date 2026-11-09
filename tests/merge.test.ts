import {test} from 'node:test';
import assert from 'node:assert/strict';
import {threeWayMerge} from '../src/lib/merge.ts';
import {makeState} from '../shared/defaults.ts';

test('ID arrays preserve additions made by both sessions',()=>{
  const base=[{id:'existing',name:'Original'}];
  const local=[...base,{id:'local',name:'Local item'}];
  const remote=[...base,{id:'remote',name:'Remote item'}];
  const merged=threeWayMerge(base,local,remote);
  assert.deepEqual(new Set(merged.map(item=>item.id)),new Set(['existing','local','remote']));
});

test('deleting one ID does not discard another ID edited in the other session',()=>{
  const base=[{id:'a',name:'A'},{id:'b',name:'B'}];
  const local=[{id:'b',name:'B'}];
  const remote=[{id:'a',name:'A'},{id:'b',name:'Edited B'}];
  assert.deepEqual(threeWayMerge(base,local,remote),[{id:'b',name:'Edited B'}]);
});

test('independent fields on the same object are merged without replacing the object',()=>{
  const base={id:'board',name:'Untitled',settings:{background:'#fff',grid:false}};
  const local={...base,name:'A board'};
  const remote={...base,settings:{background:'#222',grid:true}};
  assert.deepEqual(threeWayMerge(base,local,remote),{id:'board',name:'A board',settings:{background:'#222',grid:true}});
});

test('concurrent favorite or drawer additions from both sessions are preserved',()=>{
  const base={favorites:['existing'],drawer:[] as string[]};
  const local={favorites:['existing','local-product'],drawer:['local-product']};
  const remote={favorites:['existing','remote-product'],drawer:['remote-product']};
  const merged=threeWayMerge(base,local,remote);
  assert.deepEqual(new Set(merged.favorites),new Set(['existing','local-product','remote-product']));
  assert.deepEqual(new Set(merged.drawer),new Set(['local-product','remote-product']));
});

test('a favorite removal and a different remote addition both survive',()=>{
  const base={favorites:['a','b']};
  const local={favorites:['b']};
  const remote={favorites:['a','b','c']};
  assert.deepEqual(new Set(threeWayMerge(base,local,remote).favorites),new Set(['b','c']));
});

test('numeric vectors remain ordered values when both sessions change different properties',()=>{
  const base={position:[0,0,0],color:'#fff'};
  const local={position:[1,2,3],color:'#fff'};
  const remote={position:[0,0,0],color:'#333'};
  assert.deepEqual(threeWayMerge(base,local,remote),{position:[1,2,3],color:'#333'});
});

test('an unchanged local item respects a remote deletion while retaining a local addition',()=>{
  const base=[{id:'a',name:'A'},{id:'b',name:'B'}];
  const local=[...base,{id:'c',name:'C'}];
  const remote=[{id:'b',name:'B'}];
  assert.deepEqual(threeWayMerge(base,local,remote),[{id:'b',name:'B'},{id:'c',name:'C'}]);
});

test('a local reorder and a remote ID addition are both retained',()=>{
  const base=[{id:'a'},{id:'b'}];
  const local=[{id:'b'},{id:'a'}];
  const remote=[{id:'a'},{id:'b'},{id:'c'}];
  assert.deepEqual(threeWayMerge(base,local,remote).map(item=>item.id),['b','a','c']);
});

test('two workspace sessions can edit separate resources without losing either edit',()=>{
  const base=makeState([]);const local=structuredClone(base);const remote=structuredClone(base);
  local.projects[0].boards[0].name='Local board';
  remote.projects[0].schedules[0].name='Remote schedule';remote.revision=1;
  const merged=threeWayMerge(base,local,remote);
  assert.equal(merged.projects[0].boards[0].name,'Local board');
  assert.equal(merged.projects[0].schedules[0].name,'Remote schedule');
  assert.equal(merged.revision,1);
});

test('team member additions and independent role changes are merged by email',()=>{
  const base={members:[{email:'a@example.test',role:'viewer'}]};
  const local={members:[...base.members,{email:'b@example.test',role:'editor'}]};
  const remote={members:[{email:'a@example.test',role:'editor'}]};
  const merged=threeWayMerge(base,local,remote);
  assert.deepEqual(merged.members,[{email:'a@example.test',role:'editor'},{email:'b@example.test',role:'editor'}]);
});
