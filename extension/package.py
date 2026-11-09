from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

root = Path(__file__).resolve().parent
destination = root.parent / "public" / "clipper" / "monogram-clipper.zip"
manifest = json.loads((root / "manifest.json").read_text())
assert manifest["manifest_version"] == 3
assert set(manifest["permissions"]) == {"activeTab", "scripting", "storage"}
assert not manifest.get("host_permissions")
destination.parent.mkdir(parents=True, exist_ok=True)
files = ["manifest.json", "popup.html", "popup.css", "popup.js", "extractor.js", "icons/monogram.png", "README.md"]
with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(root / name, name)
print(f"Packaged {len(files)} files: {destination.name}")
