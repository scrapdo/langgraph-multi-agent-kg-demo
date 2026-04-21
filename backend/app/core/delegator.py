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
- When you decide to call ANY tool (quick_lookup, route_to_specialist, control_app, schedule_proactive, list_proactive, cancel_proactive), call it SILENTLY. Do NOT speak before the tool call. Do NOT say "let me check", "one moment", "looking that up", or give a placeholder general-knowledge answer. Your first output in that turn IS the tool call, nothing more.
- After the tool result comes back, speak the actual answer. Do not narrate the tool you used.
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
- calendar_create({title, start_iso, end_iso, notes?, calendar?}) — creates a calendar event. CONFIRMATION REQUIRED.

Rules:
- "play some focus music" → spotify_play_query(query="focus"). "pause" → spotify_pause. "skip" → spotify_next.
- When the operator asks to ADD a calendar event, go STRAIGHT to calendar_create after the confirmation gate. Do NOT call calendar_list_today as a "let me check first" step.
- start_iso / end_iso must be full ISO format: "YYYY-MM-DDTHH:MM:SS" (no Z, no timezone offset, local time). If the operator says "tomorrow at 8:15pm", compute the actual date/time yourself.
- Never invent phone numbers or emails — if you don't have the contact, ask.

CONFIRMATION GATE (MANDATORY for destructive actions):
Before calling messages_send, mail_compose with send=true, or calendar_create, you MUST read the full content back and wait for an explicit "yes", "confirm", "send it", "do it", or "add it" before calling.

Examples of the confirmation readback:
- messages_send → "About to text <to>: '<body>'. Send?"
- mail_compose(send=true) → "Sending email to <to>, subject '<subject>'. Confirm?"
- calendar_create → "Creating '<title>' from <start time> to <end time>. Add it?"

After the operator confirms, call the tool with ALL required fields in a single call. Don't split across turns, don't omit fields. The tool has no memory between calls — it needs title, start_iso, and end_iso in the same call.

If the operator hesitates, says "wait", "no", or gives a partial/unclear answer, DO NOT call the tool. Ask a clarifying question.

SCHEDULE PROACTIVE TASKS when the operator asks for something recurring — "every morning at 8am give me X", "daily at 6 tell me Y", "every Monday summarize Z". Call `schedule_proactive` with a clear name, a standalone prompt, local time (hour/minute), and the weekdays. For "daily" use all seven. If the operator asks "what am I running?", call `list_proactive` and read back the list in one short sentence. To cancel, use `cancel_proactive` — but confirm the specific task name before calling.

HAND OFF via the `route_to_specialist` tool when the request needs real work (research, writing, wellness advice, etc.):
- secretary — calls, texts, emails, scheduling, follow-ups, inbox triage.
- wellness — habits, goals, training, recovery, nutrition, accountability.
- shopper — product research, price comparisons, purchase decisions.
- social — posts, campaigns, platform strategy, content calendars.
- researcher — multi-step research or analysis that needs synthesis and a full written brief: market analysis, medical device job market, product comparisons, multi-source summaries, deep dives. For quick single-fact web lookups (weather, scores, open-now, one-off prices), use `quick_lookup` instead — those don't need the specialist.
- news — ONLY daily news briefings (national or Baltimore-local headlines). Never for sports, stats, or one-off topic queries — those go to researcher.
- writer — drafting, rewrites, longer written content.
- coder — software engineering, code review, implementation.

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
    "calendar": ["list_today", "create"],
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
            "description": "Return the list of scheduled proactive tasks the operator has configured.",
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
    ]


def build_realtime_session_payload(
    model: str,
    voice: str,
    *,
    operator_profile: str = "",
) -> dict[str, Any]:
    """Assemble the JSON body for POST /v1/realtime/sessions.

    The operator profile is appended to the delegator's instructions so every
    Realtime turn has context (location, timezone, current focus, etc.) — this
    lets the delegator answer questions like "what NBA games today" without
    asking "which location?" when it already knows the operator is in Baltimore.
    The delegator is the one place personalization is safe: specialist runs
    still skip the profile to avoid it leaking into written outputs.
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
    return {
        "model": model,
        "voice": voice,
        "instructions": instructions,
        "tools": build_delegator_tools(),
        "tool_choice": "auto",
        "modalities": ["audio", "text"],
        "input_audio_format": "pcm16",
        "output_audio_format": "pcm16",
        "input_audio_transcription": {"model": "whisper-1"},
        "turn_detection": {
            "type": "server_vad",
            "threshold": 0.5,
            "prefix_padding_ms": 300,
            "silence_duration_ms": 500,
        },
    }
