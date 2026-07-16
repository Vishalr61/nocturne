# Verifies the QoL batch in the real app:
#   1. Double-click a word (scroll mode) → definition card; popover has no Define.
#   2. Clicking text does NOT toggle chrome; clicking the margin does.
#   3. A scrubber jump shows the "back to page" pill; tapping it returns.
#   4. Sage highlight swatch saves and renders the green tint.
#   5. Stats card, sort select, per-book size, and Install button on the shelf.
# Needs `npm run dev` running on :5173.
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

CHROME = str(next(Path.home().glob(
    "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")))
BOOK = str(Path.home() / "Documents/Hobby/Books/enders_game_-_full_novel.pdf")
SHOTS = Path(__file__).parent / "shots"
SHOTS.mkdir(exist_ok=True)


def ensure_chrome(page):
    # Retry: the 4s auto-hide can fire between the check and the click.
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
    switch_mode(page, "scroll")
    time.sleep(3)

    # --- 1. double-click define ---------------------------------------------
    spot = page.evaluate("""() => {
      const spans = document.querySelectorAll("[data-text-layer] span[data-s]");
      for (const s of spans) {
        if (!/[A-Za-z]{6,}/.test(s.textContent)) continue;
        const r = s.getBoundingClientRect();
        if (r.top > 120 && r.top < 700) return { x: r.left + 12, y: r.top + r.height / 2 };
      }
      return null;
    }""")
    page.mouse.dblclick(spot["x"], spot["y"])
    time.sleep(2)
    card = page.locator("[data-defcard]").count()
    senses = page.locator("[data-defcard] ol li").count()
    print("1. dblclick define card:", card, "senses:", senses, "=>",
          "PASS" if card == 1 and senses > 0 else "FAIL")
    ok &= card == 1 and senses > 0
    page.screenshot(path=str(SHOTS / "qol_dbltap_define.png"))
    page.mouse.click(200, 800)  # dismiss card
    time.sleep(0.6)

    # --- 2. chrome asymmetry: text tap hides but never summons ---------------
    ensure_chrome(page)
    visible_before = page.locator("button[aria-label='Reading settings']").count()

    def text_spot():
        return page.evaluate("""() => {
          const spans = document.querySelectorAll("[data-text-layer] span[data-s]");
          for (const s of spans) {
            if (!/[A-Za-z]{6,}/.test(s.textContent)) continue;
            const r = s.getBoundingClientRect();
            if (r.top > 160 && r.top < 640) return { x: r.left + Math.min(10, r.width / 2), y: r.top + r.height / 2 };
          }
          return null;
        }""")

    spot2 = text_spot()
    page.mouse.click(spot2["x"], spot2["y"])  # text tap with chrome visible → hides
    time.sleep(0.6)
    after_hide = page.locator("button[aria-label='Reading settings']").count()
    spot3 = text_spot()  # hiding chrome reflowed nothing (overlay) but recompute anyway
    page.mouse.click(spot3["x"], spot3["y"])  # text tap with chrome hidden → stays hidden
    time.sleep(0.6)
    after_text = page.locator("button[aria-label='Reading settings']").count()
    page.mouse.click(2, 500)  # margin tap summons
    time.sleep(0.6)
    after_margin = page.locator("button[aria-label='Reading settings']").count()
    print("2. chrome: before", visible_before, "| text-tap hides →", after_hide,
          "| text-tap summons →", after_text, "| margin-tap →", after_margin, "=>",
          "PASS" if visible_before == 1 and after_hide == 0 and after_text == 0 and after_margin == 1 else "FAIL")
    ok &= visible_before == 1 and after_hide == 0 and after_text == 0 and after_margin == 1

    # --- 3. back-to-spot pill ------------------------------------------------
    ensure_chrome(page)
    page.evaluate("""() => {
      const el = document.querySelector("input[aria-label='Go to page']");
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(el, 150);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }""")
    time.sleep(2)
    pill = page.locator("text=Back to page").count()
    page.locator("text=Back to page").click()
    time.sleep(2)
    page_after = page.locator("input[aria-label='Page number']").input_value()
    print("3. back pill shown:", pill, "| returned to page:", page_after, "=>",
          "PASS" if pill == 1 and int(page_after) <= 3 else "FAIL")
    ok &= pill == 1 and int(page_after) <= 3

    # --- 4. sage highlight ----------------------------------------------------
    page.evaluate("""() => {
      const spans = document.querySelectorAll("[data-text-layer] span[data-s]");
      for (const s of spans) {
        const m = /[A-Za-z]{6,}/.exec((s.firstChild && s.firstChild.textContent) || "");
        if (!m) continue;
        const r = document.createRange();
        r.setStart(s.firstChild, m.index);
        r.setEnd(s.firstChild, m.index + m[0].length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        return true;
      }
      return false;
    }""")
    page.wait_for_selector("button[aria-label='Highlight (sage)']", timeout=5000)
    no_define = page.locator("text=Define").count()
    page.locator("button[aria-label='Highlight (sage)']").click()
    time.sleep(2)
    sage = page.evaluate("""() =>
      [...document.querySelectorAll('div')].filter(d =>
        d.style.background && d.style.background.includes('143, 174, 139')).length
    """)
    print("4. sage rects:", sage, "| Define in popover:", no_define, "=>",
          "PASS" if sage > 0 and no_define == 0 else "FAIL")
    ok &= sage > 0 and no_define == 0
    page.screenshot(path=str(SHOTS / "qol_sage_highlight.png"))

    # --- 5. shelf: stats card, sort, size, install button --------------------
    page.evaluate("""() => new Promise((resolve, reject) => {
      const req = indexedDB.open('nocturne');
      req.onsuccess = () => {
        const db = req.result;
        const d = new Date();
        const day = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const tx = db.transaction('readingLog', 'readwrite');
        tx.objectStore('readingLog').put({ day, ms: 47 * 60000, pages: 62 });
        tx.oncomplete = () => { db.close(); resolve(true); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    })""")
    page.reload()
    time.sleep(3)
    stats_card = page.locator("text=Your reading").count()
    sort_sel = page.locator("select[aria-label='Sort books']").count()
    size_txt = page.locator("text=/\\d+(\\.\\d+)? MB/").count()
    install = page.locator("text=Install Nocturne").count()
    print("5. stats:", stats_card, "| sort:", sort_sel, "| size:", size_txt,
          "| install:", install, "=>",
          "PASS" if stats_card == 1 and size_txt > 0 and install == 1 else "FAIL")
    ok &= stats_card == 1 and size_txt > 0 and install == 1
    page.screenshot(path=str(SHOTS / "qol_shelf.png"))

    ctx.close()
    browser.close()

print("ALL PASS" if ok else "SOMETHING FAILED")
