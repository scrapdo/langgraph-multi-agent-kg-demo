import asyncio

from app.services.secretary_service import SecretaryService


def test_resolve_contact_dispatch_uses_saved_preference(tmp_path):
    service = SecretaryService()
    service._contacts_path = lambda: tmp_path / "contacts.json"  # type: ignore[method-assign]
    service.save_contact(
        {
            "contact_id": "dentist",
            "name": "Dentist Office",
            "preferred_channel": "email",
            "preferred_provider": "sendgrid",
            "email": "desk@example.com",
        }
    )
    channel, provider, destination = service.resolve_contact_dispatch("dentist", "auto", "auto", "")
    assert channel == "email"
    assert provider == "sendgrid"
    assert destination == "desk@example.com"


def test_dispatch_wellness_outreach_only_targets_opted_in_contacts(tmp_path):
    service = SecretaryService()
    service._contacts_path = lambda: tmp_path / "contacts.json"  # type: ignore[method-assign]
    service._history_path = lambda: tmp_path / "history.json"  # type: ignore[method-assign]
    service.save_contact(
        {
            "contact_id": "opted-in",
            "name": "Opted In",
            "preferred_channel": "telegram",
            "preferred_provider": "telegram",
            "telegram_chat_id": "12345",
            "wellness_opt_in": True,
        }
    )
    service.save_contact(
        {
            "contact_id": "not-opted",
            "name": "Not Opted",
            "preferred_channel": "telegram",
            "preferred_provider": "telegram",
            "telegram_chat_id": "67890",
            "wellness_opt_in": False,
        }
    )

    async def fake_dispatch(**kwargs):
        return {"status": "simulated", **kwargs}

    service.dispatch = fake_dispatch  # type: ignore[assignment]
    results = asyncio.run(
        service.dispatch_wellness_outreach(
            {
                "mode": "simulation",
                "outreach_channel": "telegram",
                "outreach_provider": "telegram",
                "outreach_message": "Check in today.",
            }
        )
    )
    assert len(results) == 1
    assert results[0]["contact_id"] == "opted-in"
