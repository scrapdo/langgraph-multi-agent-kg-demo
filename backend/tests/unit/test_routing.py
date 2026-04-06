from app.agents.nodes import should_critic_route, should_research_continue


def test_research_continue_routes_to_critic_when_enough_notes():
    state = {"research_notes": ["a", "b"]}
    assert should_research_continue(state) == "critic"


def test_research_continue_routes_to_degraded_when_not_enough_notes():
    state = {"research_notes": ["a"]}
    assert should_research_continue(state) == "degraded"


def test_critic_routes_to_researcher_when_fail_and_revisions_available():
    state = {"critique_flags": ["critic_failed"], "revision_count": 0, "max_revisions": 2}
    assert should_critic_route(state) == "researcher"


def test_critic_routes_to_degraded_when_fail_and_no_revisions_left():
    state = {"critique_flags": ["critic_failed"], "revision_count": 2, "max_revisions": 2}
    assert should_critic_route(state) == "degraded"
