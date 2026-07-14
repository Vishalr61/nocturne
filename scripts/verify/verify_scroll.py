import time
from pathlib import Path
from playwright.sync_api import sync_playwright

CHROME = str(next(Path.home().glob("Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")))
BOOK = str(Path.home() / "Documents/Hobby/Books/Dungeon Crawler Carl.pdf")

SCROLLER = "div.relative.flex-1.overflow-auto"


def open_settings(page):
    page.locator("button[aria-label='Reading settings']").click()
    page.wait_for_selector("text=Reading settings", timeout=5000)


def close_settings(page):
    page.locator("button[aria-label='Close settings']").click()
    time.sleep(0.3)


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME)
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    page = ctx.new_page()
    page.on("pageerror", lambda e: print("pageerror:", str(e)[:200]))
    page.goto("http://localhost:5173")
    page.locator("input[type=file]").first.set_input_files(BOOK)
    page.wait_for_selector("button[aria-label='Reading settings']", timeout=120000)
    time.sleep(2)

    # Switch to scroll mode.
    open_settings(page)
    page.locator("button:has-text('scroll')").last.click()
    close_settings(page)
    time.sleep(2)

    # Scroll to a deliberately mid-page position (page ~12.6).
    slot = page.eval_on_selector(SCROLLER, "el => el.scrollHeight") / 384
    target = 11.6 * slot  # top of viewport at page 12.6
    page.eval_on_selector(SCROLLER, "(el, t) => { el.scrollTop = t }", target)
    time.sleep(2.5)  # throttle (400ms) + persist
    before = page.eval_on_selector(SCROLLER, "el => el.scrollTop")
    print("scrollTop before reload:", round(before), " (target", round(target), ")")

    # Footer stat: tap percent -> pages left in chapter.
    stat = page.locator("button[aria-label='Switch between percent and pages left in chapter']")
    print("stat shows:", stat.inner_text())
    stat.click()
    time.sleep(0.3)
    print("stat after tap:", stat.inner_text())

    # Relaunch the app (launches into last book) and check restore.
    page.reload()
    page.wait_for_selector("button[aria-label='Reading settings']", timeout=120000)
    time.sleep(3)
    after = page.eval_on_selector(SCROLLER, "el => el.scrollTop")
    print("scrollTop after reload:", round(after))
    drift = abs(after - before)
    print("drift px:", round(drift), "=> ", "PASS" if drift < 40 else "FAIL")

    # Footer stat choice persisted?
    print("stat after reload:", stat.inner_text())
    browser.close()
