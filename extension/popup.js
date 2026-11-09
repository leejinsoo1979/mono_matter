import {extractProduct,safeWebUrl,workspaceClipUrl} from './extractor.js';

const $ = id => document.getElementById(id);
const defaultWorkspace = 'http://127.0.0.1:5188';
let extracted = null;
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
const saved = await chrome.storage.local.get('workspaceUrl');
$('workspace').value = safeWebUrl(saved.workspaceUrl) || defaultWorkspace;

$('save-settings').addEventListener('click', async () => {
  const url = safeWebUrl($('workspace').value.trim());
  if (!url) return status('Enter an http or https workspace address.', true);
  await chrome.storage.local.set({workspaceUrl:url});
  $('workspace').value = url;
  status('Workspace address saved on this browser.');
});

$('extract').addEventListener('click', async () => {
  $('extract').disabled = true;
  try {
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab?.id || !safeWebUrl(tab.url)) throw new Error('Open an http or https product page first. Browser settings pages cannot be clipped.');
    const [execution] = await chrome.scripting.executeScript({target:{tabId:tab.id},func:extractProduct});
    if (!execution?.result?.sourceUrl) throw new Error('This page could not be read. Try a product detail page.');
    extracted = execution.result;
    for (const field of ['name','brand','image','description','price','currency']) $(field).value = extracted[field] ?? '';
    $('source').value = extracted.sourceUrl;
    $('product-form').hidden = false;
    status('Review the extracted details before continuing.');
  } catch (error) { status(error.message || 'This page could not be read.', true); }
  finally { $('extract').disabled = false; }
});

$('product-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!extracted) return;
  const workspace = safeWebUrl($('workspace').value.trim());
  const sourceUrl = safeWebUrl($('source').value.trim());
  const image = $('image').value.trim();
  if (!workspace || !sourceUrl || (image && !safeWebUrl(image))) return status('Workspace, source, and image addresses must use http or https.', true);
  const product = {name:$('name').value.trim(),brand:$('brand').value.trim(),image:image ? safeWebUrl(image) : '',description:$('description').value.trim(),sourceUrl,...(extracted.category?{category:extracted.category}:{})};
  if (!product.name) return status('Enter a product name.', true);
  if ($('price').value !== '') { const price = Number($('price').value); if (!Number.isFinite(price) || price < 0) return status('Enter a valid non-negative price.', true); product.price = price; }
  if ($('currency').value.trim()) product.currency = $('currency').value.trim();
  const url = workspaceClipUrl(workspace, product);
  if (url.length > 60000) return status('The clipped details are too long. Shorten the description.', true);
  $('save').disabled = true;
  try { await chrome.storage.local.set({workspaceUrl:workspace}); await chrome.tabs.create({url}); status('Opened in monogram for final review.'); }
  catch { status('The workspace could not be opened. Check its address.', true); }
  finally { $('save').disabled = false; }
});
