import asyncio
from pydantic import BaseModel
from typing import Optional, List
from naver_blog_v01 import generate_article, Persona, WriteConfig, StrategyManager

class P(BaseModel):
    job: str = "개발자"
    age: str = "30대"
    career: str = "10년"
    family: str = "1명"
    theme_color: str = "teal"

async def test():
    persona = P()
    config = WriteConfig(style="정보형", tone="친근한", golden_time="auto", cta_enabled=True)
    res = await generate_article("test_id", persona, "테스트", config, [], "none", "")
    print(res)

asyncio.run(test())
