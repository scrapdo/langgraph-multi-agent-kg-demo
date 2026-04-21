# Ask My Brain — Browser Extension

A minimal Chrome / Chromium / Brave / Edge extension that sends the current page
(URL, title, highlighted selection, and an optional question) to your locally-running
LangGraph Brain and notifies you when the run finishes.

Does the same thing as the bookmarklet, with the benefits of:

- **Keyboard shortcut** (`⌘⇧B` on macOS, `Ctrl+Shift+B` elsewhere)
- **Popup** with an optional question field
- **Completion notifications** that include the answer preview
- **Configurable API base** so you can point at a non-default host

## Install (unpacked)

1. Make sure your brain backend is running and reachable at
   `http://127.0.0.1:8000` (or whatever host you want to configure).
2. Open `chrome://extensions`, enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and pick the `browser_extension/` folder.
4. Pin the extension to the toolbar.
5. (Optional) open the popup and change the API base if you reach the brain
   over LAN — e.g. `http://10.0.0.5:8000`.

## Using it

- **Toolbar icon**: click it, optionally type a question, press **Send to brain**.
  The extension also has a "Summarise this page" shortcut in the popup.
- **Keyboard**: the default shortcut fires the same action without opening the
  popup. Rebind in `chrome://extensions/shortcuts` if it collides.

## How it talks to the brain

- Sends `POST /ask-about-page` with `{url, title, selection, question?}` (JSON
  payload with `Content-Type: text/plain` to avoid CORS preflight).
- Polls `GET /runs/{id}` until the run is terminal (max 10 min).
- Fires a `chrome.notifications` with up to 220 chars of the assistant's output.

## Permissions

- `activeTab` — read the active tab's URL/title + inject a small script to grab
  the current selection.
- `scripting` — pair with `activeTab` to read the selection.
- `storage` — persist the API base URL.
- `notifications` — show "run started" and "run finished" banners.
- `host_permissions` scoped to `http://127.0.0.1/*` and `http://localhost/*`.

## Firefox / Safari

The manifest is v3 and uses the cross-browser `chrome.*` namespace, so Firefox
should accept it with a small signing tweak. Safari needs to be packaged via
Xcode's Safari Web Extension converter. I have not tested either — start with
Chrome / Brave / Edge.
