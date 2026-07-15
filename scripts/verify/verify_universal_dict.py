# Verifies selection + dictionary in every view mode, and open-to-shelf:
#   1. Scroll mode: selection works with NO select mode — popover offers
#      Highlight + Copy (Define moved to double-tap, so it must NOT be there).
#   2. Text Mode: DOM selection → popover with Copy but NO Highlight
#      (reflowed text has no page range to persist); double-click → card.
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
    # Chrome auto-hides (4s); a MARGIN tap brings it back — taps on text no
    # longer toggle it. Retry: the timer can fire between check and click.
    for _ in range(3):
        if page.locator("button[aria-label='Reading settings']").count() > 0:
            return
        page.mouse.click(2, 500)
        time.sleep(0.5)


def switch_mode(page, label):
    for _ in range(3):
        ensure_chrome(page)
        try:
            page.locator("button[aria-label='Reading settings']").click(timeout=3000)
            break
        except Exception:
            continue
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
    page.wait_for_selector("button[aria-label='Highlight (amber)']", timeout=5000)
    has_copy = page.locator("text=Copy").count()
    no_define = page.locator("text=Define").count()
    print("1. scroll popover: Copy:", has_copy, "| Define present:", no_define,
          "=>", "PASS" if has_copy == 1 and no_define == 0 else "FAIL")
    ok &= has_copy == 1 and no_define == 0
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
    page.wait_for_selector("text=Copy", timeout=5000)
    no_mark = page.locator("button[aria-label='Highlight (amber)']").count()
    page.evaluate("() => window.getSelection().removeAllRanges()")
    time.sleep(1)
    spot = page.evaluate("""() => {
      for (const host of document.querySelectorAll("[data-textreader] p")) {
        for (const node of host.childNodes) {
          if (node.nodeType !== 3) continue;
          const m = /[A-Za-z]{6,}/.exec(node.textContent);
          if (!m) continue;
          const r = document.createRange();
          r.setStart(node, m.index);
          r.setEnd(node, m.index + m[0].length);
          const b = r.getBoundingClientRect();
          if (b.top > 120 && b.top < 700) return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        }
      }
      return null;
    }""")
    page.mouse.dblclick(spot["x"], spot["y"])
    time.sleep(2)
    senses = page.locator("[data-defcard] ol li").count()
    print("2. text-mode dblclick senses:", senses, "| Highlight offered:", no_mark,
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
