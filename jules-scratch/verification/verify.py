import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()

        # Listen for and print console messages
        page.on("console", lambda msg: print(f"Browser Console: {msg.text}"))

        await page.goto('http://localhost:8000')

        # Wait for the loader to be hidden, with a timeout
        try:
            await page.wait_for_selector('#loader', state='hidden', timeout=60000)
            print("Loader hidden successfully.")
            await page.screenshot(path='jules-scratch/verification/verification.png')
            print("Screenshot taken.")
        except Exception as e:
            print(f"An error occurred: {e}")
        finally:
            await browser.close()

if __name__ == '__main__':
    asyncio.run(main())
