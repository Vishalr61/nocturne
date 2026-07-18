# Pace intelligence: with a seeded pace record (10+ min of signal), the
# time-left estimates surface in the popover, the Contents header, and the
# shelf hero — and stay HIDDEN without signal.
# Needs `npm run dev` on :5173.
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

CHROME = str(next(Path.home().glob(
    "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")))
BOOK = str(Path.home() / "Documents/Hobby/Books/DCC/DungeonCrawlerCarl.pdf")
SHOTS = Path(__file__).parent / "shots"

ok = True
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME)
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    page = ctx.new_page()
    page.on("pageerror", lambda e: print("pageerror:", str(e)[:200]))
    page.goto("http://localhost:5173")
    page.locator("input[type=file]").first.set_input_files(BOOK)
    page.wait_for_selector("button[aria-label='Reading settings']", timeout=120000)
    time.sleep(2)

    # No signal yet → no estimate anywhere.
    page.locator("button[aria-label='Reading settings']").click()
    time.sleep(1)
    bare = page.locator("text=left in this book").count()
    print("1. hidden without signal:", bare == 0, "=>", "PASS" if bare == 0 else "FAIL")
    ok &= bare == 0
    page.locator("button[aria-label='Close settings']").click()
    time.sleep(0.5)

    # Seed a pace: 1 min per percent, 12 min signal → 181-page book at p1 ≈ 99% left.
    book_id = page.evaluate("""() => new Promise((res) => {
      const r = indexedDB.open('nocturne');
      r.onsuccess = () => {
        const tx = r.result.transaction('books', 'readonly');
        tx.objectStore('books').getAllKeys().onsuccess = function () { res(this.result[0]); r.result.close(); };
      };
    })""")
    page.evaluate(
        "(id) => localStorage.setItem('nocturne-pace-' + id, JSON.stringify({ msPerPct: 60000, signalMs: 720000 }))",
        book_id,
    )
    page.reload()
    page.wait_for_selector("text=Resume reading", timeout=60000)
    hero = page.locator("text=/~.+ left/").count()
    print("2. shelf hero estimate:", hero, "=>", "PASS" if hero >= 1 else "FAIL")
    ok &= hero >= 1

    page.locator("text=Resume reading").click()
    page.wait_for_selector("button[aria-label='Reading settings']", timeout=60000)
    time.sleep(2)
    page.locator("button[aria-label='Reading settings']").click()
    time.sleep(1)
    pop = page.locator("text=left in this book").count()
    print("3. popover estimate:", pop, "=>", "PASS" if pop == 1 else "FAIL")
    ok &= pop == 1
    page.screenshot(path=str(SHOTS / "pace_popover.png"))
    page.locator("button[aria-label='Close settings']").click()
    time.sleep(0.5)

    for _ in range(4):  # chrome auto-hide races the click
        if page.locator("button[aria-label='Contents']").count() == 0:
            page.mouse.click(195, 500)
            time.sleep(0.7)
        try:
            page.locator("button[aria-label='Contents']").click(timeout=2500)
            break
        except Exception:
            continue
    time.sleep(1)
    toc_est = page.locator("text=in the book").count()
    print("4. contents estimate:", toc_est, "=>", "PASS" if toc_est >= 1 else "FAIL")
    ok &= toc_est >= 1
    page.screenshot(path=str(SHOTS / "pace_contents.png"))

    browser.close()
print("ALL PASS" if ok else "SOMETHING FAILED")
