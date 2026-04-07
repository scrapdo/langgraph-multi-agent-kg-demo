from __future__ import annotations


class LocalAppService:
    def get_catalog(self) -> list[dict[str, object]]:
        return [
            {
                "id": "microsoft_word",
                "label": "Microsoft Word",
                "category": "documents",
                "actions": ["create_doc", "save_local", "export_pdf"],
                "notes": "Best for briefs, proposals, and formatted documents saved locally.",
            },
            {
                "id": "finder_files",
                "label": "Finder / Local Files",
                "category": "files",
                "actions": ["save_local", "organize_files", "open_folder"],
                "notes": "Use for local file creation, organization, and output delivery on disk.",
            },
            {
                "id": "gmail_calendar",
                "label": "Gmail / Calendar Workflow",
                "category": "scheduling",
                "actions": ["monitor_inbox", "draft_reply", "propose_schedule", "update_calendar"],
                "notes": "Requires a connector or automation bridge for real mailbox and calendar changes.",
            },
            {
                "id": "heygen_studio",
                "label": "HeyGen / Avatar Studio",
                "category": "media",
                "actions": ["render_avatar_video", "map_avatar", "generate_video"],
                "notes": "Use for avatar-led social or explainer video outputs.",
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
        ]


local_app_service = LocalAppService()
