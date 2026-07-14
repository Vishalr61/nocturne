import time
from pathlib import Path
from playwright.sync_api import sync_playwright

CHROME = str(next(Path.home().glob("Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")))
BOOK = str(Path.home() / "Documents/Hobby/Books/Dungeon Crawler Carl.pdf")
OUT = Path(__file__).parent / "shots"
OUT.mkdir(exist_ok=True)


def set_value(page, selector, value):
    page.eval_on_selector(
        selector,
        """(el, v) => {
          const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          set.call(el, v); el.dispatchEvent(new Event('input', {bubbles: true}));
        }""",
        str(value),
    )


def open_settings(page):
    if page.locator("text=Reading settings").count() == 0:
        page.locator("button[aria-label='Reading settings']").click()
        page.wait_for_selector("text=Reading settings", timeout=5000)


def close_settings(page):
    page.locator("button[aria-label='Close settings']").click()
    time.sleep(0.3)


def pick_theme(page, name):
    open_settings(page)
    page.locator(f"button:has-text('{name}')").first.click()
    close_settings(page)
    time.sleep(1.5)


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME)
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    page = ctx.new_page()
    page.on("pageerror", lambda e: print("pageerror:", str(e)[:200]))
    page.goto("http://localhost:5173")
    page.locator("input[type=file]").first.set_input_files(BOOK)
    page.wait_for_selector("button[aria-label='Reading settings']", timeout=120000)
    time.sleep(2)

    # Jump to the chapter-1 divider page (icon page, per outline p8).
    set_value(page, "input[aria-label='Page number']", "8")
    page.keyboard.press("Enter")
    time.sleep(2)

    # 1. Paged mode, Soft Dark (default) then Paper.
    page.screenshot(path=str(OUT / "1-paged-dark-p8.png"))
    pick_theme(page, "Paper")
    time.sleep(1.5)
    page.screenshot(path=str(OUT / "2-paged-paper-p8.png"))

    # 2. Text Mode entered directly on Paper (fresh render on light theme).
    open_settings(page)
    page.locator("button:has-text('text')").last.click()
    close_settings(page)
    time.sleep(3)
    page.screenshot(path=str(OUT / "3-text-paper-fresh.png"))

    # 3. Theme staleness: switch to Soft Dark and back to Paper while in Text Mode.
    pick_theme(page, "Soft Dark")
    page.screenshot(path=str(OUT / "4-text-dark-switched.png"))
    pick_theme(page, "Paper")
    page.screenshot(path=str(OUT / "5-text-paper-switched-back.png"))

    browser.close()
print("done")
