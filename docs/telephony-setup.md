# Telephony (phone calls for the Secretary)

When you say "secretary, call the vet and confirm Tuesday," the coordinator
confirms with you, then fires the `secretary_place_call` tool. The backend
dials Twilio, Twilio opens a **Media Stream** WebSocket to the API, and the
API bridges that stream to **OpenAI Realtime** — so the callee has a natural
voice conversation with the Secretary's persona.

Same pipe handles inbound: when someone calls the Twilio number, Twilio
POSTs to `/telephony/incoming`, gets TwiML back that opens a media stream,
and the Secretary picks up.

## One-time setup

### 1. Install [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/tunnel-guide/local/)

```bash
brew install cloudflared
```

This gives you a persistent public URL that tunnels to `localhost:8000`. No
account needed for quick tunnels.

### 2. Start the tunnel alongside the backend

```bash
cloudflared tunnel --url http://localhost:8000
```

`cloudflared` prints a URL like `https://abc-def-ghi.trycloudflare.com`.
Copy it — that's your public base.

(Leave this terminal open. The URL stays stable until you stop `cloudflared`.
For a durable URL you don't have to re-paste, run `cloudflared tunnel login`
+ `cloudflared tunnel create brain` and use your own subdomain.)

### 3. Add the public URL to your secrets file

In `~/.config/the-brain/secrets.env`:

```
TELEPHONY_PUBLIC_BASE=https://abc-def-ghi.trycloudflare.com
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+12408522074
```

Restart the stack (`docker compose up -d` from `infra/`) so the env reloads.

### 4. Configure your Twilio number's voice webhook

1. Open https://console.twilio.com/us1/develop/phone-numbers/manage/incoming
2. Click `+1 (240) 852-2074`
3. Under **Voice Configuration**:
   - **A call comes in** → Webhook
   - URL: `https://<your-tunnel>.trycloudflare.com/telephony/incoming`
   - Method: `HTTP POST`
4. Save.

Twilio will now POST to that URL on every inbound call. The backend validates
the request signature (HMAC-SHA1 with your auth token) and returns TwiML that
opens the media stream.

## What happens during a call

**Inbound** — someone dials (240) 852-2074:
1. Twilio rings. After 1-2 seconds, the call connects and a short "please hold
   while I connect you to Matt's assistant" plays.
2. The Secretary's voice comes on. It's OpenAI Realtime with a phone-specific
   persona — it knows it's on a phone line, keeps replies short, takes messages
   when appropriate.
3. Either side hangs up → both sockets close cleanly.

**Outbound** — you say "secretary, call +14105551234 and tell them I'll be
ten minutes late":
1. Delegator confirms: "About to call +14105551234 about 'telling them Matt
   will be ten minutes late'. Go ahead?"
2. You say yes.
3. Delegator silently calls `secretary_place_call`. Backend hits Twilio's REST
   API with your number as caller-ID. Twilio dials.
4. When the callee answers, Twilio POSTs `/telephony/outgoing`, gets TwiML
   back, opens the media stream, Secretary greets: "Hi, this is Matt's
   assistant calling on his behalf about…"

## Troubleshooting

**"TELEPHONY_PUBLIC_BASE not configured"** on `/telephony/place-call` →
the env var is unset or the container hasn't picked it up. Set it in
`~/.config/the-brain/secrets.env` and restart `api`.

**Inbound call rings but Twilio plays an error** → open Twilio's [Debugger
Events](https://console.twilio.com/us1/monitor/logs/debugger) page and look
for the error. Most common: webhook returned 500 (check backend logs), or
webhook URL is http not https.

**Call connects but no audio from the Secretary** → open the backend logs
during a test call. Look for `telephony_openai_error` or
`telephony_openai_pump_ended`. The most common cause is OpenAI's Realtime
endpoint refusing the connection because the account doesn't have Realtime
access yet.

**"Invalid Twilio signature" (403)** → your `TELEPHONY_PUBLIC_BASE` and the
URL Twilio is actually hitting disagree. If you're behind a proxy or using a
tunnel that rewrites paths, set the env to the host Twilio sees.

## Security notes

- `/telephony/incoming` and `/telephony/outgoing` validate Twilio's HMAC-SHA1
  signature using `TWILIO_AUTH_TOKEN`. Requests without a valid signature
  return 403. (Validation is skipped only when the auth token isn't set, so
  dev environments without Twilio credentials don't bounce on themselves.)
- The public tunnel exposes your whole backend — including the Delegator,
  Mission Control, and any other routes. If that's a concern, route Twilio
  through an nginx layer that only forwards `/telephony/*` publicly.
- Outbound calls are gated by the Delegator's confirmation readback. The
  model won't place calls without an explicit "yes" from you.

## Known limits (V1)

- **No call transcript persistence yet.** The live audio is bridged but we
  don't save the full conversation to Zep/Neo4j after the call. Next iteration
  will push the Realtime transcript events into `memory_service.add_episode`
  and attach a summary to the delegator's next turn.
- **No call list in the UI.** Completed calls don't surface in the Briefings
  or Team outputs rail. Follow-up work.
- **No SMS bridge here.** Secretary SMS already works via `secretary_service`
  (documented separately) — this doc is voice-only.
