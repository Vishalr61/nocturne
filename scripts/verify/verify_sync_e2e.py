# End-to-end sync proof against the PRODUCTION worker:
#   Device A: import a book, read to page 42, enable sync, capture the secret.
#   Device B (fresh storage): adopt the secret → the book appears as a ghost →
#   re-add the same PDF → open it → resumes at page 42.
# State only, E2E-encrypted; the worker stores opaque ciphertext. The test
# writes a handful of throwaway records under a random test secret.
# Needs `npm run dev` on :5173.
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

CHROME = str(next(Path.home().glob(
    "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")))
BOOK = str(Path.home() / "Documents/Hobby/Books/enders_game_-_full_novel.pdf")
SHOTS = Path(__file__).parent / "shots"
SHOTS.mkdir(exist_ok=True)

ok = True
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME)

    # --- Device A -----------------------------------------------------------
    ctx_a = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    a = ctx_a.new_page()
    a.on("pageerror", lambda e: print("A pageerror:", str(e)[:200]))
    a.goto("http://localhost:5173")
    a.locator("input[type=file]").first.set_input_files(BOOK)
    a.wait_for_selector("button[aria-label='Reading settings']", timeout=120000)
    time.sleep(2)
    if a.locator("input[aria-label='Page number']").count() == 0:
        a.mouse.click(2, 500)
        time.sleep(0.6)
    a.locator("input[aria-label='Page number']").fill("42")
    time.sleep(3)  # progress persists on page change
    a.locator("button[aria-label='Back to library']").click()
    time.sleep(1.5)
    a.locator("footer button:has-text('Sync')").click()
    time.sleep(0.8)
    a.locator("input[aria-label='Enable sync']").click(force=True)
    a.wait_for_selector("input[aria-label='Device secret']", timeout=15000)
    time.sleep(2)  # enabling generates the secret and pushes
    secret = a.locator("input[aria-label='Device secret']").input_value()
    print("A: secret captured:", secret[:8] + "…", "| enabled:", bool(secret))
    ok &= bool(secret)
    a.locator("button:has-text('Sync now')").click()
    time.sleep(4)
    a.screenshot(path=str(SHOTS / "sync_device_a.png"))
    ctx_a.close()

    # --- Device B (fresh) ----------------------------------------------------
    ctx_b = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    b = ctx_b.new_page()
    b.on("pageerror", lambda e: print("B pageerror:", str(e)[:200]))
    b.goto("http://localhost:5173")
    time.sleep(2)
    b.locator("footer button:has-text('Sync')").click()
    time.sleep(0.8)
    b.locator("summary:has-text('secret from another device')").click()
    b.locator("input[aria-label='Paste secret']").fill(secret)
    b.locator("button:has-text('Use')").click()
    time.sleep(6)  # adopt pulls everything
    b.locator("button[aria-label='Close sync']").click()
    time.sleep(1.5)
    ghost = b.locator("text=from your other device").count()
    print("B: ghost shelf shown:", ghost, "=>", "PASS" if ghost == 1 else "FAIL")
    ok &= ghost == 1
    b.screenshot(path=str(SHOTS / "sync_ghost.png"))

    # Re-add the same PDF: the content hash matches the ghost and it resumes.
    b.locator("input[type=file]").first.set_input_files(BOOK)
    b.wait_for_selector("button[aria-label='Reading settings']", timeout=120000)
    time.sleep(3)
    if b.locator("input[aria-label='Page number']").count() == 0:
        b.mouse.click(2, 500)
        time.sleep(0.6)
    page_no = b.locator("input[aria-label='Page number']").input_value()
    print("B: resumed at page:", page_no, "=>", "PASS" if page_no == "42" else "FAIL")
    ok &= page_no == "42"
    b.screenshot(path=str(SHOTS / "sync_resumed.png"))
    ctx_b.close()
    browser.close()

print("ALL PASS" if ok else "SOMETHING FAILED")
