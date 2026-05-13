import json

from app.repositories.run_store import JsonRunStore


def test_json_run_store_persists_records(tmp_path):
    store_path = tmp_path / "runs.json"
    store = JsonRunStore(str(store_path))

    created = store.create("run-1", "hello", "simulation")
    assert created["status"] == "queued"

    updated = store.update("run-1", status="completed", state={"spoken_response": "done"}, output="report")
    assert updated["status"] == "completed"

    reloaded = JsonRunStore(str(store_path))
    rec = reloaded.get("run-1")
    assert rec is not None
    assert rec["status"] == "completed"
    assert rec["state"]["spoken_response"] == "done"
    assert rec["output"] == "report"

    raw = json.loads(store_path.read_text())
    assert raw["run-1"]["task"] == "hello"
