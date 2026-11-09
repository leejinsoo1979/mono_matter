import test from 'node:test';
import assert from 'node:assert/strict';
import {safeWorkspacePath,catalogLocation,isMarketingPath} from '../src/lib/site-routes.ts';

test('source search, category and product intents survive an authentication return URL',()=>{
  for(const destination of ['/catalog?q=%EC%9B%90%EB%AA%A9%20%26%20oak','/catalog/furniture?product=1216','/catalog?type=Material&settings=plan']){
    const login=new URL('/login?returnTo='+encodeURIComponent(destination),'http://monogram.local');
    const restored=safeWorkspacePath(login.searchParams.get('returnTo'));
    assert.equal(restored,destination);
    assert.deepEqual(catalogLocation(restored),catalogLocation(destination));
  }
  assert.equal(catalogLocation('/catalog/furniture').type,'Furniture');
  assert.equal(catalogLocation('/catalog?q=%EC%9B%90%EB%AA%A9%20%26%20oak').query,'원목 & oak');
});
test('authentication destinations reject external, protocol-relative and non-workspace routes',()=>{
  for(const input of ['https://example.com/catalog','//example.com/catalog','/\\example.com/catalog','javascript:alert(1)','/catalog/../../','/login?returnTo=https://example.com','/pricing',undefined])assert.equal(safeWorkspacePath(input),'/catalog');
  assert.equal(safeWorkspacePath('/file/board/abc-123?view=3d'),'/file/board/abc-123?view=3d');
});
test('only marketing pages skip the workspace bootstrap gate',()=>{
  for(const path of ['/','/landing','/material-board','/pricing','/privacy-statement'])assert.equal(isMarketingPath(path),true);
  for(const path of ['/catalog','/catalog/furniture','/login','/signup','/file/board/abc','/library','/projects','/supplier'])assert.equal(isMarketingPath(path),false);
});
