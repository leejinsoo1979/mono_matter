import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {extractProduct,safeWebUrl,workspaceClipUrl} from './extractor.js';

function extract({product,meta={},h1='',title='',url='https://shop.example.test/products/chair?session=private#private'}={}) {
  const document = {
    title,
    querySelectorAll: selector => selector === 'script[type="application/ld+json"]' && product ? [{textContent:JSON.stringify(product)}] : [],
    querySelector: selector => {
      if (selector === 'h1') return {textContent:h1};
      const key = /meta\[property="([^"]+)"/.exec(selector)?.[1];
      return key && meta[key] ? {getAttribute:() => meta[key]} : null;
    },
    get cookie() { throw new Error('Cookie access is prohibited'); },
  };
  return JSON.parse(JSON.stringify(vm.runInNewContext(`(${extractProduct.toString()})()`,{document,location:{href:url},URL})));
}

test('Product JSON-LD yields only product fields and strips session data from addresses',() => {
  const result = extract({product:{'@graph':[{'@type':'Product',name:' Oak chair ',brand:{name:'Studio'},description:'A chair',image:'https://cdn.example.test/chair.jpg?w=600&token=private',offers:{price:'249.50',priceCurrency:'USD'},category:'Chairs'}]}});
  assert.deepEqual(result,{name:'Oak chair',brand:'Studio',description:'A chair',image:'https://cdn.example.test/chair.jpg?w=600',sourceUrl:'https://shop.example.test/products/chair',price:249.5,currency:'USD',category:'Chairs'});
});
test('Meta fallback works without inventing a price, and unsafe image schemes are rejected',() => {
  const result = extract({h1:'A real product',meta:{'og:image':'javascript:alert(1)','description':'Public description','product:brand':'Maker'}});
  assert.equal(result.name,'A real product');assert.equal(result.brand,'Maker');assert.equal(result.image,'');assert.ok(!('price' in result));assert.equal(result.description,'Public description');
  assert.equal(extract({h1:'No image'}).image,'');
});
test('Only explicit http/https workspace addresses can receive the review payload',() => {
  for (const value of ['javascript:alert(1)','file:///etc/passwd','data:text/html,test','https://name:password@example.test/']) assert.equal(safeWebUrl(value),'');
  const payload={name:'Chair',image:'https://cdn.example.test/chair.jpg',sourceUrl:'https://shop.example.test/chair'};
  const url=new URL(workspaceClipUrl('http://127.0.0.1:5173',payload));assert.equal(url.pathname,'/clip');assert.deepEqual(JSON.parse(decodeURIComponent(url.hash.slice(1))),payload);assert.equal(url.search,'');
  assert.equal(new URL(workspaceClipUrl('https://workspace.example.test/clip/',payload)).pathname,'/clip');
});
test('MV3 manifest grants only the requested permissions and has no background collector',() => {
  const manifest=JSON.parse(readFileSync(new URL('./manifest.json',import.meta.url),'utf8'));
  assert.equal(manifest.manifest_version,3);assert.deepEqual([...manifest.permissions].sort(),['activeTab','scripting','storage']);assert.ok(!manifest.host_permissions);assert.ok(!manifest.content_scripts);assert.ok(!manifest.background);
});
