import asyncio
import httpx
import os
from dotenv import load_dotenv

load_dotenv()
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

async def test():
    async with httpx.AsyncClient() as client:
        r = await client.get(
            "https://api.anthropic.com/v1/models",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
            }
        )
        print(r.status_code, r.text)

asyncio.run(test())
