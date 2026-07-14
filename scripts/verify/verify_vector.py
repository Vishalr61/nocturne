import time
from pathlib import Path
from playwright.sync_api import sync_playwright

CHROME = str(next(Path.home().glob("Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")))
BOOK = str(Path.home() / "Documents/Hobby/Books/enders_game_-_full_novel.pdf")
OUT = Path(__file__).parent / "exports"


def set_value(page, selector, value):
    page.eval_on_selector(
        selector,
        """(el, v) => {
          const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          set.call(el, v); el.dispatchEvent(new Event('input', {bubbles: true}));
        }""",
        str(value),
    )


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME)
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: print("pageerror:", str(e)[:300]))
    page.goto("http://localhost:5173")
    page.locator("input[type=file]").first.set_input_files(BOOK)
    page.wait_for_selector("button[aria-label='Reading settings']", timeout=60000)
    time.sleep(2)
    page.locator("button[aria-label='Reading settings']").click()
    page.wait_for_selector("text=Reading settings", timeout=5000)
    page.locator("button:has-text('Page range')").click()
    set_value(page, "input[aria-label='Export from page']", "3")
    set_value(page, "input[aria-label='Export to page']", "5")
    btn = page.locator("xpath=//div[div[div[normalize-space(text())='Dark PDF, vector']]]/button").first
    with page.expect_download(timeout=300000) as dl:
        btn.click()
    dl.value.save_as(OUT / "vector-range.pdf")
    print("saved", OUT / "vector-range.pdf")
    browser.close()
