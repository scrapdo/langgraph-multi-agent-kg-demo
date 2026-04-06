from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any


class EventBus:
    def __init__(self) -> None:
        self._queues: dict[str, list[asyncio.Queue]] = defaultdict(list)

    async def publish(self, run_id: str, event: dict[str, Any]) -> None:
        for queue in list(self._queues[run_id]):
            await queue.put(event)

    async def subscribe(self, run_id: str) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue()
        self._queues[run_id].append(queue)
        return queue

    def unsubscribe(self, run_id: str, queue: asyncio.Queue) -> None:
        if run_id in self._queues and queue in self._queues[run_id]:
            self._queues[run_id].remove(queue)


event_bus = EventBus()
