# monogram web clipper

A small Manifest V3 extension for Chrome and Edge. It only reads a page after you press **Extract from this page**. Review the visible fields, then press **Save to monogram** to open your workspace's import form. Complete the final product save there.

## Install locally

1. Unzip `monogram-clipper.zip` into a folder.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on Developer mode and choose **Load unpacked**.
4. Select the folder containing `manifest.json`.
5. Pin the extension. Open a product page and click its icon.

The default workspace address is `http://127.0.0.1:5188`. Change it inside the popup if monogram runs elsewhere. The address is stored only in this extension's browser storage.

## Privacy and permissions

The only permissions are `activeTab`, `scripting`, and `storage`. There is no background worker, automatic content script, host permission, cookie access, browsing-history access, remote API request, or external image preview. Only public product JSON-LD, product meta tags, the main heading, title, and source address are inspected. Query parameters and fragments are dropped from the source address; only common image-rendering parameters are retained on extracted image URLs.

The import payload contains `name`, `brand`, `image`, `description`, `sourceUrl`, and optional `price`, `currency`, and `category`. It is encoded in the workspace URL's fragment, so it is not sent to the server as part of the HTTP request. The app displays it for review before saving.

## Validate and package

```sh
node --test extension/clipper.test.mjs
python3 extension/package.py
```

The package script writes `public/clipper/monogram-clipper.zip`. This is an unpacked extension distribution; it is not a Chrome Web Store or Edge Add-ons publication.
