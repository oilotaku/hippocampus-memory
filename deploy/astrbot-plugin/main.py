# memory-constellations-bridge
# 把 AstrBot 收到的訊息轉發到 Memory Constellations 記憶庫的 /api/messages，
# 讓記憶庫的 Scribe 自動提取記憶。只負責「喂訊息」，不負責回覆。
#
# 配置記憶庫地址：設定環境變數 MEMORY_API_BASE（預設 http://127.0.0.1:3000）
# Docker 部署時填 http://<記憶庫容器名>:3000

import os
import aiohttp
from astrbot.api.star import Context, Star, filter
from astrbot.api.event import AstrMessageEvent

MEMORY_API_BASE = os.environ.get("MEMORY_API_BASE", "http://127.0.0.1:3000")


class MemoryConstellationsBridge(Star):
    def __init__(self, context: Context):
        super().__init__(context)

    async def _send(self, sender: str, content: str):
        """POST 一條訊息到記憶庫，失敗靜默（不阻塞聊天）。"""
        content = (content or "").strip()
        if not content:
            return
        try:
            async with aiohttp.ClientSession() as session:
                await session.post(
                    f"{MEMORY_API_BASE}/api/messages",
                    json={"sender": sender, "content": content},
                    timeout=aiohttp.ClientTimeout(total=5),
                )
        except Exception:
            pass  # 記憶庫不可用時靜默跳過，不影響 AstrBot 正常聊天

    @filter.on_message()
    async def on_user_message(self, event: AstrMessageEvent):
        """使用者發的訊息 → 記憶庫（sender=user）。"""
        await self._send("user", event.message_str)

    @filter.on_decorating_result()
    async def on_bot_reply(self, event: AstrMessageEvent):
        """機器人回覆的訊息 → 記憶庫（sender=bot），讓記憶庫也記住它說過的話。"""
        try:
            # 機器人最終回覆的純文本
            reply = event.message_str or ""
        except Exception:
            reply = ""
        await self._send("bot", reply)
