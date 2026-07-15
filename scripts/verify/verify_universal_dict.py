# Verifies selection + dictionary in every view mode, and open-to-shelf:
#   1. Scroll mode: long-press-equivalent selection works with NO select mode —
#      popover offers Highlight/Copy/Define, Define shows senses.
#   2. Text Mode: DOM selection → popover with Define but NO Highlight
#      (reflowed text has no page range to persist).
#   3. Relaunch opens the shelf (home), not the last book.
# Needs `npm run dev` running on :5173.
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

CHROME = str(next(Path.home().glob(
    "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")))
BOOK = str(Path.home() / "Documents/Hobby/Books/enders_game_-_full_novel.pdf")
SHOTS = Path(__file__).parent / "shots"
SHOTS.mkdir(exist_ok=True)

SELECT_WORD_JS = """() => {
  const hosts = document.querySelectorAll("%s");
  for (const host of hosts) {
    for (const node of host.childNodes) {
      if (node.nodeType !== 3) continue;
      const m = /[A-Za-z]{6,}/.exec(node.textContent);
      if (!m) continue;
      const r = document.createRange();
      r.setStart(node, m.index);
      r.setEnd(node, m.index + m[0].length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      return m[0];
    }
  }
  return null;
}"""


def ensure_chrome(page):
    # Chrome auto-hides while reading; a centre tap brings it back.
    if page.locator("button[aria-label='Reading settings']").count() == 0:
        page.mouse.click(195, 500)
        time.sleep(0.6)


def switch_mode(page, label):
    ensure_chrome(page)
    page.locator("button[aria-label='Reading settings']").click()
    page.wait_for_selector("text=Reading settings", timeout=5000)
    page.locator("button:has-text('%s')" % label).last.click()
    time.sleep(0.5)
    page.locator("button[aria-label='Close settings']").click()
    time.sleep(2)


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

    # --- 1. scroll mode: selection live without any mode --------------------
    switch_mode(page, "scroll")
    time.sleep(3)  # let slots render + text layers mount
    word = page.evaluate(SELECT_WORD_JS % "[data-text-layer] span[data-s]")
    print("   scroll: selected", word)
    page.wait_for_selector("text=Define", timeout=5000)
    has_mark = page.locator("text=★ Highlight").count()
    page.locator("text=Define").click()
    time.sleep(2)
    senses = page.locator("ol li").count()
    print("1. scroll-mode Define senses:", senses, "| Highlight offered:", has_mark,
          "=>", "PASS" if senses > 0 and has_mark == 1 else "FAIL")
    ok &= senses > 0 and has_mark == 1
    page.screenshot(path=str(SHOTS / "dict_scroll.png"))
    page.evaluate("() => window.getSelection().removeAllRanges()")
    time.sleep(1)

    # --- 2. Text Mode: define/copy, no highlight ----------------------------
    switch_mode(page, "text")
    time.sleep(3)
    ensure_chrome(page)
    page.locator("input[aria-label='Page number']").fill("5")  # past the cover
    time.sleep(3)
    word = page.evaluate(SELECT_WORD_JS % "[data-textreader] p")
    print("   text mode: selected", word)
    page.wait_for_selector("text=Define", timeout=5000)
    no_mark = page.locator("text=★ Highlight").count()
    page.locator("text=Define").click()
    time.sleep(2)
    senses = page.locator("ol li").count()
    print("2. text-mode Define senses:", senses, "| Highlight offered:", no_mark,
          "=>", "PASS" if senses > 0 and no_mark == 0 else "FAIL")
    ok &= senses > 0 and no_mark == 0
    page.screenshot(path=str(SHOTS / "dict_textmode.png"))

    # --- 3. relaunch lands on the shelf --------------------------------------
    page.reload()
    time.sleep(3)
    on_shelf = page.locator("input[type=file]").count() > 0
    in_reader = page.locator("button[aria-label='Reading settings']").count() > 0
    print("3. relaunch shows shelf:", on_shelf, "| reader:", in_reader,
          "=>", "PASS" if on_shelf and not in_reader else "FAIL")
    ok &= on_shelf and not in_reader
    page.screenshot(path=str(SHOTS / "open_to_shelf.png"))

    ctx.close()
    browser.close()

print("ALL PASS" if ok else "SOMETHING FAILED")
