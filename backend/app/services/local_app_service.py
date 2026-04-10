from __future__ import annotations


class LocalAppService:
    def get_catalog(self) -> list[dict[str, object]]:
        return [
            {
                "id": "adobe_acrobat",
                "label": "Adobe Acrobat",
                "category": "documents",
                "actions": ["open_pdf", "extract_text", "annotate_pdf", "export_pdf"],
                "notes": "Useful for PDF review, text extraction, markup, and packaged deliverables.",
            },
            {
                "id": "microsoft_word",
                "label": "Microsoft Word",
                "category": "documents",
                "actions": ["create_doc", "save_local", "export_pdf"],
                "notes": "Best for briefs, proposals, and formatted documents saved locally.",
            },
            {
                "id": "terminal_shell",
                "label": "Terminal",
                "category": "developer",
                "actions": ["run_command", "inspect_logs", "launch_script", "manage_files"],
                "notes": "Use for controlled shell tasks, logs, scripts, and local developer workflows.",
            },
            {
                "id": "finder_files",
                "label": "Finder / Local Files",
                "category": "files",
                "actions": ["save_local", "organize_files", "open_folder"],
                "notes": "Use for local file creation, organization, and output delivery on disk.",
            },
            {
                "id": "manus_desktop",
                "label": "Manus Desktop",
                "category": "ai_tools",
                "actions": ["open_app", "handoff_task", "review_output"],
                "notes": "Reserved for Manus-specific handoff or review workflows through the host bridge.",
            },
            {
                "id": "chatgpt_desktop",
                "label": "ChatGPT Desktop",
                "category": "ai_tools",
                "actions": ["open_app", "handoff_prompt", "review_output"],
                "notes": "Useful when an agent needs to open or hand off context into the ChatGPT desktop app.",
            },
            {
                "id": "codex_desktop",
                "label": "Codex Desktop",
                "category": "ai_tools",
                "actions": ["open_app", "handoff_prompt", "review_output"],
                "notes": "Use for local Codex-oriented coding or terminal handoff workflows.",
            },
            {
                "id": "claude_desktop",
                "label": "Claude Desktop",
                "category": "ai_tools",
                "actions": ["open_app", "handoff_prompt", "review_output"],
                "notes": "Use for Claude desktop task handoff and review flows.",
            },
            {
                "id": "docker_desktop",
                "label": "Docker Desktop",
                "category": "developer",
                "actions": ["open_app", "inspect_containers", "restart_stack", "open_dashboard"],
                "notes": "Useful for infra operators and coding agents managing local services.",
            },
            {
                "id": "gmail_calendar",
                "label": "Gmail / Calendar Workflow",
                "category": "scheduling",
                "actions": ["monitor_inbox", "draft_reply", "propose_schedule", "update_calendar"],
                "notes": "Requires a connector or automation bridge for real mailbox and calendar changes.",
            },
            {
                "id": "ai_influencer_studio",
                "label": "AI Influencer Studio",
                "category": "social",
                "actions": ["create_post_assets", "generate_social_media", "prepare_campaign_assets"],
                "notes": "Intended for specialist social content workflows if you connect the underlying toolchain.",
            },
            {
                "id": "photoshop_media",
                "label": "Photoshop / Media Editor",
                "category": "media",
                "actions": ["generate_image", "edit_image", "prepare_creatives"],
                "notes": "Useful for social creatives, thumbnails, and campaign assets.",
            },
            {
                "id": "telephony_sms",
                "label": "Calls / SMS",
                "category": "communications",
                "actions": ["place_call", "send_sms", "appointment_followup"],
                "notes": "Use with Twilio or another telephony provider for real outbound calls and texts.",
            },
            {
                "id": "email_outreach",
                "label": "Email Outreach",
                "category": "communications",
                "actions": ["send_email", "draft_email", "appointment_booking"],
                "notes": "Use with Gmail or SendGrid for booking, follow-up, and secretary workflows.",
            },
            {
                "id": "telegram_messaging",
                "label": "Telegram Messaging",
                "category": "communications",
                "actions": ["send_message", "share_checkin", "follow_up"],
                "notes": "Useful for Telegram-based reminders, accountability check-ins, and wellness nudges.",
            },
        ]


local_app_service = LocalAppService()
