"""Instructions and tool schemas for the OpenAI Realtime 'delegator' agent.

The delegator is the voice-first front-of-house persona for the multi-agent
team. It greets the operator, handles small talk and simple questions on its
own, and routes domain work to the right specialist via the
``route_to_specialist`` tool. When it routes, the frontend kicks off a normal
backend run for that specialist; the specialist's final answer is played back
in that specialist's ElevenLabs voice.
"""

from __future__ import annotations

from typing import Any

# agent_id -> backend task_type that forces the specialist path.
# Keep in sync with app.graph.state.AgentState.task_type and the coordinator.
SPECIALIST_ROUTES: dict[str, dict[str, str]] = {
    "secretary": {
        "task_type": "secretary",
        "description": "Calls, texts, emails, scheduling, follow-ups, inbox triage.",
    },
    "wellness": {
        "task_type": "wellness_coaching",
        "description": "Habits, goals, training, recovery, nutrition, accountability.",
    },
    "shopper": {
        "task_type": "shopping",
        "description": "Product research, price comparisons, purchase decisions.",
    },
    "social": {
        "task_type": "social_media",
        "description": "Posts, campaigns, platform strategy, content calendars.",
    },
    "researcher": {
        "task_type": "market_research",
        "description": (
            "Open-ended research across live web and knowledge sources: market "
            "analysis, comparisons, multi-source synthesis, sports results, stats, "
            "general facts-with-citations."
        ),
    },
    "news": {
        "task_type": "news_brief",
        "description": (
            "Daily news briefings — national or Baltimore-local headlines only. "
            "Not for sports scores, stats, or topic queries that aren't news headlines."
        ),
    },
    "writer": {
        "task_type": "conversation",
        "description": "General writing, drafting, rewrites, explanations.",
    },
    "coder": {
        "task_type": "conversation",
        "description": "Software engineering, code review, debugging, implementation.",
    },
}


DELEGATOR_INSTRUCTIONS = """\
You are the coordinator of a multi-agent operations team. You are the single voice the operator hears when they speak to the system. Your job is to understand what they want and either answer directly or hand off to the specialist who will do the actual work.

Personality:
- Warm, human, present. Slight smile in your voice. You actually sound glad to be helping.
- Competent and unflappable, like a top-tier chief of staff — not a customer-service rep. Confident, not deferential.
- Dry wit is fine in moderation; sycophancy is not. No "Great question!", no "I'd be happy to", no "Absolutely!".
- Natural prosody — vary pace and emphasis. Don't read like a teleprompter. Don't sound robotic or flat.
- Short sentences. You are being spoken out loud. Contractions are welcome.

TOOL-CALLING DISCIPLINE — read carefully:
- When you decide to call ANY tool (quick_lookup, route_to_specialist, control_app, schedule_proactive, list_proactive, cancel_proactive, secretary_place_call), call it SILENTLY. Do NOT speak before the tool call. Do NOT say "let me check", "one moment", "looking that up", or give a placeholder general-knowledge answer. Your first output in that turn IS the tool call, nothing more. EXCEPTION: destructive or live-side-effect actions (sending messages/email/calls, creating calendar events) require a confirmation gate — in those cases speak the confirmation readback first, wait for the operator's explicit yes, THEN call the tool silently.
- After the tool result comes back, speak the actual answer. Do not narrate the tool you used.
- TOOL FAILURES: when a tool result has `status: 'error'` it includes a `kind` and may include `remediation` / `remediation_url`. Don't say "couldn't do that" — read the failure shape:
  - `kind: 'auth_required'` → "I can't see your calendar yet — you'll need to connect Google in Settings first." Use the `remediation` field as your script.
  - `kind: 'rate_limited'` → "That hit a rate limit. Try again in a minute."
  - `kind: 'permission_denied'` → "Looks like macOS permissions are blocking that. Check Automation in System Settings."
  - `kind: 'execution_failed'` (or no kind) → read the `error` string back as a short spoken sentence.
  Always tell the operator the actionable thing — what they can do — not just that the tool failed.
- Exception: for route_to_specialist only, you may say ONE short handoff line ("Researcher's on it.") before the tool call — never more than one sentence, and never a generic placeholder answer.

ALWAYS ANSWER DIRECTLY (do NOT call any tool) when the operator asks about:
- What you can do, who you are, how the system works, what agents exist, how this works.
- Meta questions about you, the team, or the setup.
- Small talk, greetings, casual check-ins.
- Anything you can answer from general knowledge in one or two sentences without fresh data.

USE `quick_lookup` (fast live web search — you speak the answer in YOUR voice) for single-fact, time-sensitive questions with a short answer. Examples:
- "What's the weather in Baltimore?"
- "What's the Spurs score?"
- "Is the Apple Store open right now?"
- "What's the current price of Bitcoin?"
- "Who won last night's game?"
- "When does the next eclipse happen?"
- "What's the traffic like on 95?"
- Any one-line fact you'd search Google for and skim the first result.

Rule of thumb: if the answer fits in one or two spoken sentences, use `quick_lookup`. Don't route it to a specialist. The whole point is speed.

CONTROL LOCAL APPS using the dedicated tools below. Each is a distinct function — do NOT try to combine them or pass a nested action. Just call the specific one you need.

- spotify_play / spotify_pause / spotify_next / spotify_previous / spotify_now_playing — no arguments.
- spotify_play_query({query}) — opens a Spotify search for the query (song, artist, playlist).
- messages_send({to, body}) — sends iMessage. CONFIRMATION REQUIRED.
- mail_compose({to, subject, body, send?}) — opens a draft by default. Pass send=true only when the operator explicitly says "send it now". CONFIRMATION REQUIRED when send=true.
- calendar_list_today — lists today's events.
- calendar_list_range({days_ahead}) — lists events over the next N days (1-14). Use for "next Tuesday", "this week", "do I have anything Friday".
- calendar_create({title, start_iso, end_iso, notes?, calendar?}) — creates a calendar event. CONFIRMATION REQUIRED.

Rules:
- "play some focus music" → spotify_play_query(query="focus"). "pause" → spotify_pause. "skip" → spotify_next.
- When the operator asks ANYTHING about today's schedule, calendar, agenda, meetings, or what they have going on — "what's on my calendar", "what's today's schedule", "do I have anything later", "what's my day look like", "any meetings this afternoon" — call `calendar_list_today` SILENTLY (do not say "let me check"), then read back the events in natural speech. If the list is empty, say so. Never guess from memory.
- When the operator asks about a FUTURE day or window — "next Tuesday", "this week", "what's Friday look like", "do I have anything tomorrow", "am I free next Wednesday afternoon" — call `calendar_list_range` SILENTLY with enough `days_ahead` to cover the asked day. Pick the smallest window that covers the question (3 for "next Tuesday" if today is Sunday, 7 for "this week", 14 for "next two weeks"). Then filter the returned events down to the asked day in your spoken summary.
- When the operator asks to ADD a calendar event, go STRAIGHT to calendar_create after the confirmation gate. Do NOT call calendar_list_today or calendar_list_range as a "let me check first" step before creating.
- start_iso / end_iso must be full ISO format: "YYYY-MM-DDTHH:MM:SS" (no Z, no timezone offset, local time). If the operator says "tomorrow at 8:15pm", compute the actual date/time yourself.
- Never invent phone numbers or emails — if you don't have the contact, ask.

CONFIRMATION GATE (MANDATORY for destructive actions):
Before calling messages_send, mail_compose with send=true, calendar_create, or secretary_place_call, you MUST read the full content back and wait for an explicit "yes", "confirm", "send it", "do it", "add it", or "call them" before calling.

Examples of the confirmation readback:
- messages_send → "About to text <to>: '<body>'. Send?"
- mail_compose(send=true) → "Sending email to <to>, subject '<subject>'. Confirm?"
- calendar_create → "Creating '<title>' from <start time> to <end time>. Add it?"
- secretary_place_call → "About to call <to> about <context>. Go ahead?"

PLACING CALLS — extra rules for secretary_place_call:
- Only call numbers the operator explicitly says or confirms. Never pull numbers from memory/past conversations without asking "is the number still <X>?".
- Normalize the number to E.164 (+1 for US) before calling. If you don't have a country code, ask.
- Keep the `context` tight — what the call is about, the operator's goal, what counts as "success". Don't paste the whole conversation. Example: "Confirming Matt's dental appointment Tuesday at 2pm. Goal: confirm or reschedule."
- After the call is placed, tell the operator you've dialed and will follow up when it's done. The secretary is talking on the phone now — you are not on that call.

After the operator confirms, call the tool with ALL required fields in a single call. Don't split across turns, don't omit fields. The tool has no memory between calls — it needs title, start_iso, and end_iso in the same call.

If the operator hesitates, says "wait", "no", or gives a partial/unclear answer, DO NOT call the tool. Ask a clarifying question.

SCHEDULE PROACTIVE TASKS when the operator asks for something recurring — "every morning at 8am give me X", "daily at 6 tell me Y", "every Monday summarize Z". Call `schedule_proactive` with a clear name, a standalone prompt, local time (hour/minute), and the weekdays. For "daily" use all seven. To cancel, use `cancel_proactive` — but confirm the specific task name before calling.

SCHEDULE ONE-OFF BACKGROUND TASKS via `schedule_task` when the operator says "look into X and have it ready by tomorrow", "research Y and tell me when I'm back", "draft Z while I'm in the meeting", or anything else that's a single deliverable they don't need RIGHT NOW. The task runs immediately on a background thread; the result lands in your inbox and you'll see it as a "PENDING DELIVERIES" block in the system prompt at the start of the NEXT voice session. When you see that block, surface those items naturally at the top of the conversation ("by the way, that research on X you asked for — here's what I found"). Don't wait for the operator to ask. After you've surfaced them, they're considered delivered.

When the operator says "what did you find on X?" or "did that thing finish?", trust the PENDING DELIVERIES block — it's the freshest source. If they ask about something not in the block, say so honestly.

CREATE DOCUMENTS via `create_document` when the operator asks for a "one-pager", "writeup", "doc", "PDF", "summary I can share", "visual aid", or any other tangible artifact. The document opens in their browser; from there they can Cmd+P → Save as PDF if they want a file. Use clean Markdown — headings, bullets, tables, code fences as appropriate. Aim for a single page of substance unless they ask for length. Confirm the title silently from context (don't ask "what should I call it?" if the topic is obvious).

DO NOT READ THE DOCUMENT ALOUD. After `create_document` returns, give a short spoken confirmation ONLY — one sentence, like "Done — I opened it in your browser" or "Made you the one-pager — it's up." Do NOT recite the title back, do NOT summarize the content, do NOT enumerate sections. If the operator asks "what's in it?" or "read it to me", THEN walk them through it. Default behavior is the visual artifact does the talking.

VERIFYING PROACTIVE RESULTS (your accountability loop):
When the operator asks about a recurring task — "did my morning brief run?", "what's in my jobs report?", "why didn't I get my news today?" — you MUST call `list_proactive` before answering. Never guess or assume a scheduled task completed.

Each proactive task returned by `list_proactive` includes:
- `last_run_status`: "completed", "failed", "degraded", "stuck", or null if it never ran.
- `last_success_at`: ISO timestamp of the most recent successful finish (null if never succeeded).
- `last_output_summary`: up to 1200 chars of the last successful output. READ THIS to the operator when they ask for the result.
- `last_error`: short failure explanation when the last run didn't succeed.

Rules:
- If `last_success_at` is today and the operator asked for today's result, read `last_output_summary` aloud (condense to 3-4 sentences for spoken delivery).
- If `last_run_status` is "failed", "degraded", or "stuck", tell the operator the task failed, mention `last_error` briefly, and offer to re-run it manually.
- If the task was scheduled but never ran (no `last_run_status` at all), say so honestly — don't pretend.
- If the task WOULD have fired but hasn't yet (current time is before the scheduled hour today), say "it's scheduled for <time>, hasn't run yet today".

When the operator just asks "what am I running?", call `list_proactive` and read back names + times + most recent status in one short sentence per task.

HAND OFF via the `route_to_specialist` tool when the request needs real work (research, writing, wellness advice, etc.).

EACH SPECIALIST HAS A NAME. When the operator addresses a specialist by name ("I want Emma", "let me talk to Leo", "Grace, what should I do for...", "Frank, what do you think?"), that IS a routing trigger — call route_to_specialist with the matching agent_id.

  - secretary  (name: Emma)   — calls, texts, emails, scheduling, follow-ups, inbox triage.
  - wellness   (name: Grace)  — habits, goals, training, recovery, nutrition, accountability.
  - shopper    (name: Michelle) — product research, price comparisons, purchase decisions.
  - social     (name: Antonio)  — posts, campaigns, platform strategy, content calendars.
  - researcher (name: Leo)    — multi-step research or analysis that needs synthesis and a full written brief: market analysis, comparisons, deep dives. For quick single-fact web lookups (weather, scores, open-now, prices), use `quick_lookup` instead.
  - news                       — ONLY daily news briefings (national or Baltimore-local headlines).
  - writer     (name: George)   — drafting, rewrites, longer written content.
  - coder      (name: Chad)     — software engineering, code review, implementation.
  - critic     (name: Frank)    — quality review, sanity-checking decisions.

EXCEPTION for Emma: when the operator wants the secretary to PLACE A PHONE CALL ("have Emma call me", "Emma, call <number>", "dial me"), DO NOT route_to_specialist — call `secretary_place_call` DIRECTLY with the right `to` number and a one-sentence `context`. Routing to the secretary specialist runs the inbox/scheduling pipeline; placing a real call is a separate tool. The operator's own callback number is in the profile context above (look for "Operator's callback phone number") — use that for "call me" without asking.

CRITICAL — answering directly and routing are MUTUALLY EXCLUSIVE. For a single turn, do one OR the other, never both.

When you hand off:
1. Say ONE short sentence acknowledging the request and naming the specialist. Examples: "On it, pulling that up." / "Secretary's on it." / "Researcher's checking now."
2. Call `route_to_specialist` with the right `agent_id` and a crisp `task` — rewrite the operator's request as a direct instruction the specialist can act on.
3. STOP SPEAKING. The specialist will answer in their own voice. Do not narrate, summarize, repeat, or anticipate the answer.

When the specialist finishes (you'll get a tool result), say ONE short sentence: "Anything else?" or "Want me to follow up on that?" That's it.

If the operator is telling you something (not asking for work) — e.g. "I'm going to the gym later" — acknowledge in one sentence. No routing.

Never:
- Describe your own reasoning or tool plans out loud.
- Say "I'll call the route_to_specialist function" — just do it silently.
- Answer a specialist's question yourself when the specialist should handle it.
- Keep talking after calling the tool.
"""


APP_CONTROL_ACTIONS_BY_APP = {
    "spotify": ["play", "pause", "next", "previous", "now_playing", "play_query"],
    "messages": ["send"],
    "mail": ["compose"],
    "calendar": ["list_today", "list_range", "create"],
}
APP_CONTROL_ACTIONS = sorted(
    {action for actions in APP_CONTROL_ACTIONS_BY_APP.values() for action in actions}
)


PROACTIVE_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def build_delegator_tools() -> list[dict[str, Any]]:
    """Return the OpenAI Realtime tool schema list for the delegator."""
    return [
        {
            "type": "function",
            "name": "quick_lookup",
            "description": (
                "Fast live web search for a SINGLE-FACT, single-answer question the operator "
                "wants spoken in one or two sentences: weather, scores, open-now, traffic, "
                "stock quotes, one-off prices, news-of-the-moment, simple 'what is the current X'. "
                "You speak the answer in YOUR voice — do NOT hand this off to a specialist. "
                "Use this for anything you'd Google and skim the first result for. For multi-step "
                "research or a real written brief, use route_to_specialist(researcher) instead."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": (
                            "Standalone search query. Include the specifics you need (location, "
                            "team name, product, etc.) — do not assume the search engine has any context."
                        ),
                    },
                },
                "required": ["query"],
            },
        },
        {
            "type": "function",
            "name": "schedule_proactive",
            "description": (
                "Create a recurring proactive task the system will run on its own at "
                "a scheduled time and read/send the result to the operator. Use when "
                "the operator says things like 'every morning at 8am, give me…', "
                "'ping me daily with…', 'every Monday summarize…'. The task prompt "
                "should be a standalone instruction, as if the operator were asking "
                "it fresh at that time."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Short label shown in the UI, e.g. 'Morning brief'.",
                    },
                    "prompt": {
                        "type": "string",
                        "description": (
                            "The exact prompt to run on the schedule. Standalone — "
                            "do not reference 'the operator' or the conversation."
                        ),
                    },
                    "hour": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 23,
                        "description": "Local 24-hour hour to fire.",
                    },
                    "minute": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 59,
                        "description": "Local minute to fire.",
                    },
                    "days": {
                        "type": "array",
                        "description": (
                            "Which weekdays to fire on. Use 3-letter lowercase tokens: "
                            "mon, tue, wed, thu, fri, sat, sun. Use all seven for daily."
                        ),
                        "items": {"type": "string", "enum": PROACTIVE_DAYS},
                    },
                    "task_type": {
                        "type": "string",
                        "description": (
                            "Optional specialist to route the scheduled run through. "
                            "Useful so (e.g.) a morning news brief uses the researcher's voice."
                        ),
                        "enum": [
                            "market_research",
                            "news_brief",
                            "wellness_coaching",
                            "shopping",
                            "social_media",
                            "secretary",
                            "conversation",
                        ],
                    },
                },
                "required": ["name", "prompt", "hour", "minute", "days"],
            },
        },
        {
            "type": "function",
            "name": "list_proactive",
            "description": (
                "Return all scheduled proactive tasks AND their last-run outcome. "
                "Each task includes: name, schedule (hour/minute/days), last_run_status "
                "(completed/failed/degraded/stuck/null), last_success_at (ISO timestamp), "
                "last_output_summary (up to 1200 chars of the most recent successful output), "
                "and last_error (short failure message if the last run didn't succeed). "
                "Call this whenever the operator asks about the status or result of a "
                "recurring task — never guess whether a scheduled task completed."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
        {
            "type": "function",
            "name": "cancel_proactive",
            "description": (
                "Cancel a scheduled proactive task by id. Use the id from list_proactive. "
                "Always read the task name back and confirm with the operator before calling."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "The scheduled task id from list_proactive.",
                    },
                },
                "required": ["id"],
            },
        },
        {
            "type": "function",
            "name": "secretary_place_call",
            "description": (
                "Have the secretary place a REAL phone call on the operator's behalf. "
                "Use when the operator says things like 'secretary, call the vet and confirm "
                "Tuesday', 'call this number and tell them X', 'dial <number>'. The secretary "
                "picks up from there and handles the conversation in their own voice. "
                "CONFIRMATION REQUIRED — read the number and purpose back to the operator, "
                "wait for 'yes'/'confirm'/'go ahead' before calling. Never place calls from "
                "numbers the operator hasn't explicitly given or confirmed."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "to": {
                        "type": "string",
                        "description": (
                            "Phone number in E.164 format starting with '+' and country code, "
                            "e.g. '+14105551234'. US numbers without '+1' must be normalized "
                            "before calling."
                        ),
                    },
                    "context": {
                        "type": "string",
                        "description": (
                            "Short standalone brief the secretary will use to guide the call — "
                            "what the secretary is calling about, the operator's intent, what "
                            "counts as success. The secretary reads this as context, not verbatim. "
                            "Example: 'Confirming Matt\\'s dental appointment Tuesday at 2pm.'"
                        ),
                    },
                },
                "required": ["to", "context"],
            },
        },
        {
            "type": "function",
            "name": "route_to_specialist",
            "description": (
                "Hand off the current request to a specialist agent on the team. "
                "Use when the request is domain work (research, writing, wellness, "
                "shopping, social, secretary outreach) rather than a direct app action."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "agent_id": {
                        "type": "string",
                        "enum": sorted(SPECIALIST_ROUTES.keys()),
                        "description": "Which specialist should handle the request.",
                    },
                    "task": {
                        "type": "string",
                        "description": (
                            "Crisp, first-person instruction for the specialist. Rewrite the operator's "
                            "request into a direct task prompt that the specialist can act on without "
                            "further clarification."
                        ),
                    },
                },
                "required": ["agent_id", "task"],
            },
        },
        # Spotify transport controls — no args.
        {
            "type": "function",
            "name": "spotify_play",
            "description": "Resume playback in the Spotify desktop app.",
            "parameters": {"type": "object", "properties": {}},
        },
        {
            "type": "function",
            "name": "spotify_pause",
            "description": "Pause playback in the Spotify desktop app.",
            "parameters": {"type": "object", "properties": {}},
        },
        {
            "type": "function",
            "name": "spotify_next",
            "description": "Skip to the next track in Spotify.",
            "parameters": {"type": "object", "properties": {}},
        },
        {
            "type": "function",
            "name": "spotify_previous",
            "description": "Go back to the previous track in Spotify.",
            "parameters": {"type": "object", "properties": {}},
        },
        {
            "type": "function",
            "name": "spotify_now_playing",
            "description": "Return what's currently playing in Spotify.",
            "parameters": {"type": "object", "properties": {}},
        },
        {
            "type": "function",
            "name": "spotify_play_query",
            "description": (
                "Open a Spotify search for a song, artist, album, or playlist query. "
                "Use when the operator asks to play a specific thing."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query, e.g. 'focus music' or 'Taylor Swift'.",
                    },
                },
                "required": ["query"],
            },
        },
        # Messages (iMessage).
        {
            "type": "function",
            "name": "messages_send",
            "description": (
                "Send an iMessage to a phone number or Apple ID email. "
                "CONFIRMATION REQUIRED — read the recipient + body back and wait "
                "for explicit 'yes' before calling."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "to": {
                        "type": "string",
                        "description": "Phone number (e.g. +14105551234) or iMessage email.",
                    },
                    "body": {"type": "string", "description": "The message text to send."},
                },
                "required": ["to", "body"],
            },
        },
        # Mail.
        {
            "type": "function",
            "name": "mail_compose",
            "description": (
                "Compose an email in Apple Mail. Defaults to DRAFT mode (visible, not sent). "
                "Pass send=true only after the operator explicitly says 'send it now'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "to": {"type": "string", "description": "Recipient email address."},
                    "subject": {"type": "string", "description": "Email subject line."},
                    "body": {"type": "string", "description": "Email body text."},
                    "send": {
                        "type": "boolean",
                        "description": "true to send immediately (requires confirmation). Default false = draft.",
                        "default": False,
                    },
                },
                "required": ["to", "subject", "body"],
            },
        },
        # Calendar.
        {
            "type": "function",
            "name": "calendar_list_today",
            "description": "Return today's events from the operator's Mac Calendar.",
            "parameters": {"type": "object", "properties": {}},
        },
        {
            "type": "function",
            "name": "calendar_list_range",
            "description": (
                "Return events from the operator's Mac Calendar over the next N days. "
                "Use this for any future-day question — 'next Tuesday', 'this week', "
                "'do I have anything Friday'. Pick days_ahead to cover the asked day "
                "(e.g. 3 for 'next Tuesday' if today is Sunday, 7 for 'this week')."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "days_ahead": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 14,
                        "description": "Number of days forward from today to include (1-14).",
                    },
                },
                "required": ["days_ahead"],
            },
        },
        {
            "type": "function",
            "name": "calendar_create",
            "description": (
                "Create a new event in the operator's Mac Calendar. "
                "CONFIRMATION REQUIRED — read the full title, date, and time back "
                "and wait for explicit 'yes' before calling. Go STRAIGHT to this tool "
                "once confirmed — do NOT call calendar_list_today first."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Event title — the name the operator will see on their calendar.",
                    },
                    "start_iso": {
                        "type": "string",
                        "description": (
                            "Start time in ISO format, e.g. '2026-04-23T20:15:00'. "
                            "Use the operator's local timezone. No Z suffix, no offset."
                        ),
                    },
                    "end_iso": {
                        "type": "string",
                        "description": "End time, same format as start_iso.",
                    },
                    "notes": {
                        "type": "string",
                        "description": "Optional notes/description to attach to the event (location, details).",
                    },
                    "calendar": {
                        "type": "string",
                        "description": "Optional calendar name. Omit to use the default writable calendar.",
                    },
                },
                "required": ["title", "start_iso", "end_iso"],
            },
        },
        # One-shot background task ("ask now, deliver later").
        {
            "type": "function",
            "name": "schedule_task",
            "description": (
                "Kick off a one-shot background task and return immediately. "
                "Use when the operator asks for a deliverable they don't need "
                "RIGHT NOW — research, drafts, summaries, anything that benefits "
                "from running while they're away. The result will be surfaced "
                "automatically at the start of the next voice session. Don't use "
                "this for things they want to hear NOW (just answer directly), "
                "and don't use it for recurring asks (use schedule_proactive)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": (
                            "Short descriptive label, 1-6 words. e.g. 'Research EV "
                            "tax credits'. Used to identify the task in the inbox."
                        ),
                    },
                    "prompt": {
                        "type": "string",
                        "description": (
                            "Standalone first-person instruction the workflow will "
                            "act on without further clarification. Rewrite the "
                            "operator's request into a complete task — include any "
                            "context the team needs to do the work."
                        ),
                    },
                },
                "required": ["name", "prompt"],
            },
        },
        # Document generation — markdown to a styled HTML page that opens in
        # the operator's default browser. PDF is one Cmd+P away from there.
        {
            "type": "function",
            "name": "create_document",
            "description": (
                "Render a Markdown document as a styled HTML page and open it in "
                "the operator's default browser. Use for one-pagers, writeups, "
                "summaries, plans, lists they want to share or print to PDF. The "
                "operator can Cmd+P → Save as PDF for an actual PDF file."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": (
                            "Document title shown at the top of the page. Pick a "
                            "concrete name from context — don't ask the operator "
                            "if the topic is obvious."
                        ),
                    },
                    "content_md": {
                        "type": "string",
                        "description": (
                            "Document body as Markdown. Use headings, bullets, "
                            "tables, blockquotes, and code fences as appropriate. "
                            "Default to a single page of substance unless the "
                            "operator asks for more length."
                        ),
                    },
                },
                "required": ["title", "content_md"],
            },
        },
    ]


def build_realtime_session_payload(
    model: str,
    voice: str,
    *,
    operator_profile: str = "",
    memory_context: str = "",
    inbox_brief: str = "",
) -> dict[str, Any]:
    """Assemble the JSON body for POST /v1/realtime/sessions.

    The operator profile is appended to the delegator's instructions so every
    Realtime turn has context (location, timezone, current focus, etc.) — this
    lets the delegator answer questions like "what NBA games today" without
    asking "which location?" when it already knows the operator is in Baltimore.
    The delegator is the one place personalization is safe: specialist runs
    still skip the profile to avoid it leaking into written outputs.

    `memory_context` is a Zep-rendered summary of the operator's rolling voice
    thread — what was discussed over the last days/weeks. Brain reads it
    silently and uses it to be continuous ("yesterday you mentioned..." rather
    than "what did we talk about?").

    `inbox_brief` is a short list of completed background tasks that haven't
    yet been delivered to the operator. Brain announces them at the top of
    the session so "ask now, deliver later" works naturally.
    """
    instructions = DELEGATOR_INSTRUCTIONS
    if operator_profile.strip():
        instructions += (
            "\n\n"
            "OPERATOR CONTEXT (for personalization — NEVER quote or restate this block "
            "to the operator; they wrote it themselves, so reading it back sounds weird. "
            "Use it silently to disambiguate questions like 'what's the weather?' → use "
            "their location; 'what's on TV tonight?' → use their timezone):\n"
            f"{operator_profile.strip()}"
        )
    if memory_context.strip():
        instructions += (
            "\n\n"
            "RECENT CONVERSATION CONTEXT (from your rolling voice thread — what you "
            "and the operator have been discussing recently). Use this silently for "
            "continuity. Don't recite it; just be aware of it:\n"
            f"{memory_context.strip()}"
        )
    if inbox_brief.strip():
        instructions += (
            "\n\n"
            "PENDING DELIVERIES — background tasks the operator asked for earlier "
            "have completed since you last spoke. At the START of this conversation, "
            "after greeting them, naturally surface these results. Read each one in "
            "your own words — don't quote a script. After surfacing them they're "
            "considered delivered; do not bring them up again unprompted next time.\n"
            f"{inbox_brief.strip()}"
        )
    # GA Realtime API body shape (May 2026). The legacy POST /v1/realtime/sessions
    # endpoint with a flat body (modalities, voice, input_audio_format, etc.) is
    # deprecated on May 18, 2026. The replacement POST /v1/realtime/client_secrets
    # wraps everything in a `session` object with the new nested audio schema.
    return {
        "session": {
            "type": "realtime",
            "model": model,
            "instructions": instructions,
            "tools": build_delegator_tools(),
            "tool_choice": "auto",
            "output_modalities": ["audio"],
            "audio": {
                "input": {
                    # pcm16 → audio/pcm @ 24kHz under the new MIME-typed format object.
                    "format": {"type": "audio/pcm", "rate": 24000},
                    "transcription": {"model": "whisper-1"},
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": 0.5,
                        "prefix_padding_ms": 300,
                        "silence_duration_ms": 500,
                        # When the operator starts speaking while the AI is mid-
                        # response, server VAD cancels the response. Without
                        # this, the AI talks over the user.
                        "interrupt_response": True,
                    },
                },
                "output": {
                    "format": {"type": "audio/pcm", "rate": 24000},
                    "voice": voice,
                },
            },
        },
    }
