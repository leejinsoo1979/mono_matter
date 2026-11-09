"""Import only public images/fonts observed in the reference browser session."""
import json, shutil, argparse
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from PIL import Image
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('manifest',type=Path,help='A pageAssets bundle manifest exported from the reference browser')
manifest=parser.parse_args().manifest
assets=json.loads(manifest.read_text())['assets']
rows='''1216|Gubi|F300|Lounge Chair|a3c0f97f54989e6a
732|Interface|Interpret|Machine-Woven Carpet|66b540bc3ec3eed3
35|Mirage|Clay|Porcelain Tile|f97ff41a4f5111cb
794|Minotti|Pilotis Ceramic Outdoor|Side Table|b65fce5871ff011c
860|Elastron|Alabama|Leather|07338fe7026ca41b
1073|Muuto|Cover Armchair|Armchair|70929e5fe1632dfd
54|Bobbi Beck|Albon|Vinyl Wallpaper|7133dc7218a3fbea
469|Ceragni|Biselado M10x30|Glazed Tile|a5d94b33632c3043
1210|Gubi|Beetle Soft Lounge Chair|Lounge Chair|87743b072c65500c
33|Mirage|Clay|Porcelain Tile|85ab422aa557e907
543|Dulux|Gold Superior|Latex Paint|0fb8ed4f6e3e2a85
520|Dulux|Gold Superior|Latex Paint|32ce1aa7ce709d52
335|Ceragni|Celta|Glazed Tile|898fa63f272a45e4
295|Casalis|Ondo|Board|0526091496f2adb8
820|&Tradition|Tripod HM9|Table Lamp|f24e6cb19f9bbe57
1111|Corian|Provence Nuwood|Engineered Stone|2d0f17229a3eec27
83|Mirage|Jewels JW02 Calacatta Reale|Porcelain Tile|8d939dec006a05b3
1082|Muuto|Midst Table|Dining Table|f5606c8e5608ab85
796|Minotti|Jason|Shelf|8c94f2ccd8c24863
712|Hakwood|Drift|Wood Flooring|8c48e55e75a11671
854|Muuto|Pebble Rug|Handmade Rug|6ac8cd7e9d7b2d96
727|Interface|Interpret|Machine-Woven Carpet|c7f852d67d1dace8
1039|Stinson|Katsura|Decorative Textiles|c95a08682d69790f
395|Ceragni|Artist|Glazed Tile|45a8682685f30563
933|Anzea|Intertwine|Decorative Textiles|4779d86eaefa7dc6
418|Impact Acoustic|ARCHISONIC® Felt|Acoustic Materials|500b41c19f6a9690
554|Lamitak|Baro Noce Vida|Laminate|98e846d3bbfab0f6
910|Staron|Coffee Bean|Plastic|ab4dcc128349ab6c
914|Anzea|Inner Circle|Decorative Textiles|434873b051ae0f13
238|Lapitec|Nero Antracite|Engineered Stone|8c10fc02f1c0f502
661|Ceragni|Boho|Glazed Tile|d3763f79f9ff6f3f
1140|Corian|Arrowroot|Engineered Stone|9faae472eefaa275
1014|Futura Leathers|Nappa Leder|Leather|26471e78c0d98069
1182|Object Carpet|Concept Two|Machine-Woven Carpet|0931ab177af2d07a
548|Lamitak|Runa Nevada Elm|Laminate|b479870668873f48
1173|Object Carpet|Canyon 700|Machine-Woven Carpet|2c80d99d2b8918d0
634|Ceragni|Boho|Glazed Tile|f9655c7e7096bd4b
927|Anzea|Reflection|Decorative Textiles|b21eca0e151413af
256|Lapitec|Bianco Vittoria|Engineered Stone|c36c0e760aff77d8
979|Stinson|Painted Moon|Decorative Textiles|8adc438d72eb6a82
175|Bobbi Beck|Array|Vinyl Wallpaper|eedfb8388976a991
8|Impact Acoustic|ARCHISONIC® Felt|Acoustic Materials|62e6385c220f995e
22|Ceragni|Bergen|Glazed Tile|0faa70986ce2c908
458|AAT Industrial Supplies Limited|Hairline + Anti Fingerprint|Stainless Steel|afc3d3d4d474ee09
128|Lapitec|Bianco Olimpia|Engineered Stone|022a01a8da714fad
134|Ceragni|Biselado|Glazed Tile|3615600f147d9873
500|Ceragni|Alma|Glazed Tile|fd3607d352292165'''
lookup={a['id']:a for a in assets}
out=Path('public/assets');out.mkdir(parents=True,exist_ok=True)
provenance=[]
for a in assets:
    if a['kind'] not in ('image','font'):continue
    ext='.woff2' if a['kind']=='font' else '.webp'
    dst=out/(a['id']+ext)
    if not dst.exists():shutil.copyfile(a['path'],dst)
    provenance.append({'file':str(dst),'source':a['url'],'kind':a['kind']})
products=[]
for row in rows.splitlines():
    id,brand,name,cat,asset=row.split('|')
    a=lookup[asset]
    img=Image.open(a['path']).convert('RGB');img.thumbnail((1,1));rgb=img.getpixel((0,0));color='#%02x%02x%02x'%rgb
    typ='Lighting' if 'Lamp' in cat else 'Furniture' if cat in ['Lounge Chair','Armchair','Side Table','Dining Table','Shelf'] else 'Material'
    products.append({'id':id,'name':name,'brand':brand,'category':cat,'type':typ,'image':'/assets/'+asset+'.webp','color':color,'price':0,'description':'','specs':{'Category':cat,'Brand':brand},'variants':[],'sourceUrl':'https://www.matterbase.com/p/'+id,**({'texture':'/assets/'+asset+'.webp'} if typ=='Material' else {})})
Path('data/catalog.json').write_text(json.dumps(products,ensure_ascii=False,indent=2)+'\n')
Path('reference/asset-provenance.json').write_text(json.dumps({'observedDate':'2026-10-16','referenceProductCount':len(products),'completeCatalog':False,'notes':['Only observed public cards were imported.','No unobserved price, specifications, variant names or original 3D geometry are invented.','Product color is an image average for the local preview, not a manufacturer color specification.'],'assets':provenance},ensure_ascii=False,indent=2)+'\n')
print(f'Imported {len(products)} observed products and {len(provenance)} public assets.')
