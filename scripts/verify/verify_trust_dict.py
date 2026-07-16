# Verifies the Text Mode trust pass + dictionary lookup in the real app:
#   1. Scene breaks ("* * *") render in Text Mode (Ender's Game p3), and the
#      dot-leader TOC on p2 falls back to the page image ('leaders' flag).
#   2. A low-confidence page (Sybex p26, 'table' flag) falls back to the
#      recolored page image instead of showing mangled prose.
#   3. Selecting a word in select mode offers Define and shows senses.
# Needs `npm run dev` running on :5173.
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

CHROME = str(next(Path.home().glob(
    "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")))
ENDERS = str(Path.home() / "Documents/Hobby/Books/enders_game_-_full_novel.pdf")
SYBEX = str(Path.home() / "Documents/CompTIA/SybexCompTIA.pdf")
SHOTS = Path(__file__).parent / "shots"
SHOTS.mkdir(exist_ok=True)


def load_book(ctx, book):
    page = ctx.new_page()
    page.on("pageerror", lambda e: print("pageerror:", str(e)[:200]))
    page.goto("http://localhost:5173")
    page.locator("input[type=file]").first.set_input_files(book)
    page.wait_for_selector("button[aria-label='Reading settings']", timeout=120000)
    time.sleep(2)
    return page


def text_mode(page):
    page.locator("button[aria-label='Reading settings']").click()
    page.wait_for_selector("text=Reading settings", timeout=5000)
    page.locator("button:has-text('text')").last.click()
    time.sleep(0.5)
    page.locator("button[aria-label='Close settings']").click()
    time.sleep(2)


def goto_page(page, n):
    box = page.locator("input[aria-label='Page number']")
    box.fill(str(n))
    time.sleep(3)


ok = True
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME)

    # --- 1. scene break renders in Text Mode; leader TOC falls back --------
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    page = load_book(ctx, ENDERS)
    text_mode(page)
    goto_page(page, 3)
    seps = page.locator("section[data-textpage='3'] div:text('* * *')").count()
    print("1. scene breaks on enders p3:", seps, "=>", "PASS" if seps > 0 else "FAIL")
    ok &= seps > 0
    page.screenshot(path=str(SHOTS / "trust_scene_break.png"))
    goto_page(page, 2)
    toc_canvas = page.locator("section[data-textpage='2'] canvas").count()
    toc_paras = page.locator("section[data-textpage='2'] p").count()
    print("1b. enders TOC p2 canvases:", toc_canvas, "paragraphs:", toc_paras,
          "=>", "PASS" if toc_canvas > 0 and toc_paras == 0 else "FAIL")
    ok &= toc_canvas > 0 and toc_paras == 0

    # (The old part 3 — paged select-mode Define — is gone with the T button;
    #  dictionary coverage lives in verify_qol.py / verify_universal_dict.py.)
    ctx.close()

    # --- 2. low-confidence Sybex page falls back to page image -------------
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    page = load_book(ctx, SYBEX)
    text_mode(page)
    goto_page(page, 26)
    time.sleep(3)
    canvases = page.locator("section[data-textpage='26'] canvas").count()
    paras = page.locator("section[data-textpage='26'] p").count()
    print("2. sybex p26 canvases:", canvases, "paragraphs:", paras,
          "=>", "PASS" if canvases > 0 and paras == 0 else "FAIL")
    ok &= canvases > 0 and paras == 0
    page.screenshot(path=str(SHOTS / "trust_fallback.png"))
    ctx.close()

    browser.close()

print("ALL PASS" if ok else "SOMETHING FAILED")
