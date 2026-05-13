from app.agents.nodes import _detect_task_type_for_state, _is_fast_conversation_candidate


def test_explicit_wellness_name_routes_to_wellness():
    profiles = {
        "coordinator": {"name": "Coordinator"},
        "wellness": {"name": "Ava"},
    }
    task_type = _detect_task_type_for_state(
        "Ava, help me build a realistic workout and sleep routine for this week.",
        profiles,
        conservative=True,
    )
    assert task_type == "wellness_coaching"


def test_time_sensitive_news_is_not_fast_path_candidate():
    assert _is_fast_conversation_candidate("What are the major news headlines today?") is False


def test_secretary_stays_specialist_under_conservative_mode():
    profiles = {
        "coordinator": {"name": "Coordinator"},
        "secretary": {"name": "Nora"},
    }
    task_type = _detect_task_type_for_state(
        "Book an appointment with my dentist next week and follow up if needed.",
        profiles,
        conservative=True,
    )
    assert task_type == "secretary"


def test_news_routing_prefers_news_brief_for_time_sensitive_prompt():
    profiles = {"coordinator": {"name": "Coordinator"}}
    task_type = _detect_task_type_for_state(
        "What are the major news headlines today?",
        profiles,
        conservative=True,
    )
    assert task_type == "news_brief"
