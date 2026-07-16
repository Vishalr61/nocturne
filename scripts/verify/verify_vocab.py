# Vocabulary notebook, end to end:
#   1. Double-click a word in the reader → ＋ Save on the card → ✓ Saved.
#   2. Home shows the Vocabulary card with the word and count.
#   3. Notebook opens: word row with pos chip; expand → note saves; context shown.
#   4. Delete → undo restores.
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
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    page = ctx.new_page()
    page.on("pageerror", lambda e: print("pageerror:", str(e)[:200]))
    page.goto("http://localhost:5173")
    page.locator("input[type=file]").first.set_input_files(BOOK)
    page.wait_for_selector("button[aria-label='Reading settings']", timeout=120000)
    time.sleep(2)
    # scroll mode, find a word, double-click, save
    page.locator("button[aria-label='Reading settings']").click()
    time.sleep(0.8)
    page.locator("button:has-text('scroll')").last.click()
    time.sleep(0.5)
    page.locator("button[aria-label='Close settings']").click()
    time.sleep(3)
    spot = page.evaluate("""() => {
      const spans = document.querySelectorAll("[data-text-layer] span[data-s]");
      for (const s of spans) {
        if (!/[A-Za-z]{6,}/.test(s.textContent)) continue;
        const r = s.getBoundingClientRect();
        if (r.top > 160 && r.top < 600) return { x: r.left + 12, y: r.top + r.height / 2 };
      }
      return null;
    }""")
    page.mouse.dblclick(spot["x"], spot["y"])
    time.sleep(2)
    word = page.locator("[data-defcard] p.font-serif").first.inner_text().split(" ")[0]
    page.locator("text=＋ Save").click()
    time.sleep(1)
    saved = page.locator("text=✓ Saved").count()
    print("1. saved from card:", word, "| ✓:", saved, "=>", "PASS" if saved == 1 else "FAIL")
    ok &= saved == 1

    # 2. home card — the app always launches on the shelf, so just reload.
    page.goto("http://localhost:5173")
    time.sleep(2.5)
    card = page.locator("text=Vocabulary").count()
    print("2. home vocabulary card:", card, "=>", "PASS" if card >= 1 else "FAIL")
    ok &= card >= 1

    # 3. notebook: expand, add a note
    page.locator("text=Vocabulary").first.click()
    time.sleep(1)
    page.screenshot(path=str(SHOTS / "vocab_list.png"))
    page.locator(f"span.font-serif:has-text('{word.lower()}')").first.click()
    time.sleep(0.8)
    note = page.locator(f"input[aria-label='Note for {word.lower()}']")
    if note.count() == 0:
        note = page.locator("input[placeholder='Your note…']").first
    note.fill("test note")
    page.locator("h3:has-text('Vocabulary')").click()  # blur
    time.sleep(1)
    noted = page.locator("text=test note").count()
    print("3. note saved:", noted, "=>", "PASS" if noted >= 1 else "FAIL")
    ok &= noted >= 1
    page.screenshot(path=str(SHOTS / "vocab_note.png"))

    # 4. delete + undo
    page.locator("button[aria-label^='Delete']").first.click()
    time.sleep(0.8)
    undo = page.locator("text=Undo").count()
    page.locator("text=Undo").click()
    time.sleep(1)
    restored = page.locator(f"span.font-serif:has-text('{word.lower()}')").count()
    print("4. undo offered:", undo, "| restored:", restored, "=>",
          "PASS" if undo == 1 and restored >= 1 else "FAIL")
    ok &= undo == 1 and restored >= 1

    browser.close()
print("ALL PASS" if ok else "SOMETHING FAILED")
