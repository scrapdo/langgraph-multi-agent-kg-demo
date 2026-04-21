# Running the brain on your phone (same-WiFi PWA)

You can reach your local brain from your iPhone or iPad by:

1. **Binding backend + frontend to LAN** instead of `127.0.0.1`. Edit
   `infra/docker-compose.yml`:

   ```yaml
   api:
     ports:
       - "0.0.0.0:8000:8000"   # was 127.0.0.1:8000:8000
   frontend:
     ports:
       - "0.0.0.0:5173:80"     # was 127.0.0.1:5173:80
   ```

   This exposes both to any device on your WiFi. **Only do this on a trusted
   network**, and keep `API_BEARER_TOKEN` set in `~/.config/kg-multi-agent/secrets.env`
   so random devices can't fire runs.

2. **Allow your phone's origin for CORS.** In the project `.env`:

   ```
   ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://<your-mac-lan-ip>:5173
   ```

   Restart the API container after changing.

3. **Find the Mac's LAN IP** (System Settings → Network, or `ipconfig getifaddr en0`).
4. **On the iPhone**, open Safari, go to `http://<mac-ip>:5173`.
5. Hit the share sheet → **Add to Home Screen**. The app now launches as a
   standalone PWA with the brain icon.

## What works on mobile

- Chat surface is responsive and usable on narrow screens.
- Voice mode runs natively in mobile Safari (iOS 14+). Microphone permission
  must be granted the first time.
- Mini composer + global hotkeys are macOS-only (Electron).
- Drag-and-drop attachments don't work on iOS Safari; tap the paperclip to pick
  files instead.

## What doesn't work yet

- Offline. The app requires a network round-trip to your Mac. A service-worker
  shell is not shipped — add one when needed.
- Voice push notifications. iOS won't notify you when a background run finishes
  unless the tab is open. The Electron app on your Mac does get system
  notifications via the `track-background-run` IPC.

## If you want actual push notifications on iOS

You'd need a real mobile companion (React Native / Swift). Not yet shipped.
Tier-D-level future work.
