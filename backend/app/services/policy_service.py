from __future__ import annotations

from app.core.config import settings


def live_tools() -> set[str]:
    return {x.strip() for x in settings.side_effect_live_tools_csv.split(',') if x.strip()}


def can_execute_live(tool_name: str, mode: str) -> bool:
    if mode != 'live':
        return False
    return tool_name in live_tools()


RISK_PROFILES: dict[str, dict[str, object]] = {
    "secretary_call": {
        "score": 95,
        "level": "critical",
        "requires_approval": True,
        "reasons": ["Places a real phone call to an external contact.", "High side-effect and interruption risk."],
    },
    "secretary_sms": {
        "score": 85,
        "level": "high",
        "requires_approval": True,
        "reasons": ["Sends an external text message.", "Creates a durable outbound communication record."],
    },
    "secretary_email": {
        "score": 80,
        "level": "high",
        "requires_approval": True,
        "reasons": ["Sends an external email.", "Can create irreversible external communication."],
    },
    "secretary_telegram": {
        "score": 60,
        "level": "medium",
        "requires_approval": True,
        "reasons": ["Sends an external Telegram message.", "Lower cost than SMS but still an outbound side effect."],
    },
    "social_publish": {
        "score": 78,
        "level": "high",
        "requires_approval": True,
        "reasons": ["Publishes externally to a social platform.", "Public brand and reputation risk."],
    },
    "browser_script_live": {
        "score": 72,
        "level": "high",
        "requires_approval": True,
        "reasons": ["Runs live browser actions.", "Selectors, credentials, and side effects can drift."],
    },
    "desktop_action": {
        "score": 38,
        "level": "medium",
        "requires_approval": False,
        "reasons": ["Writes or opens local desktop artifacts.", "Local filesystem or app-side effects are reversible but operationally important."],
    },
    "wellness_outreach": {
        "score": 70,
        "level": "high",
        "requires_approval": True,
        "reasons": ["Triggers proactive outbound wellness communication.", "Can message real contacts if opt-in and live mode are enabled."],
    },
}


def evaluate_operation_risk(operation: str, *, mode: str = "simulation", approval_required: bool = False) -> dict[str, object]:
    profile = RISK_PROFILES.get(operation, {
        "score": 25,
        "level": "low",
        "requires_approval": False,
        "reasons": ["Read-only or low-impact operation."],
    })
    score = int(profile["score"])  # type: ignore[arg-type]
    level = str(profile["level"])
    reasons = list(profile["reasons"])  # type: ignore[arg-type]
    requires_approval = bool(profile["requires_approval"]) or approval_required
    live_allowed = can_execute_live(operation, mode) if mode == "live" else False
    if mode != "live":
        score = max(5, score - 40)
        reasons = ["Simulation mode lowers external risk."] + reasons
    return {
        "operation": operation,
        "mode": mode,
        "score": score,
        "level": level,
        "requires_approval": requires_approval,
        "live_allowed": live_allowed,
        "reasons": reasons,
    }
