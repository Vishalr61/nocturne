# EPUB input, end to end in the real app:
#   1. Import The Martian.epub → chapters render as real text.
#   2. Contents (☰) lists the EPUB TOC; tapping an entry jumps chapters.
#   3. Reload → resumes at the same chapter (page plumbing carries chapters).
#   4. Double-click a word → dictionary card (data-textreader path).
#   5. Theme switch recolors the column (CSS, no recolor pipeline).
#   6. Corpus smoke: the other EPUBs import and render a first chapter.
# Needs `npm run dev` on :5173.
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

CHROME = str(next(Path.home().glob(
    "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")))
BOOKS = Path.home() / "Documents/Hobby/Books"
MARTIAN = str(BOOKS / "Andy Weir/Andy Weir - The Martian.epub")
CORPUS = [
    str(BOOKS / "angels-and-demons.epub"),
    str(BOOKS / "Code-Breakers-Alpha.epub"),
    str(BOOKS / "Red Rising/Morning Star_epub.epub"),
    str(BOOKS / "MHA/Safe_Keeping.epub"),
]
SHOTS = Path(__file__).parent / "shots"
SHOTS.mkdir(exist_ok=True)

ok = True
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME)
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    page = ctx.new_page()
    page.on("pageerror", lambda e: print("pageerror:", str(e)[:200]))
    page.goto("http://localhost:5173")
    page.locator("input[type=file]").first.set_input_files(MARTIAN)
    page.wait_for_selector("[data-epubchapter]", timeout=120000)
    time.sleep(2)

    # --- 1. chapters render (the first spine item is often an image-only
    #        cover, so count any sanitized content node) --------------------
    blocks = page.locator("[data-epubchapter] p, [data-epubchapter] img, [data-epubchapter] div").count()
    print("1. martian first-chapter blocks:", blocks, "=>", "PASS" if blocks > 0 else "FAIL")
    ok &= blocks > 0
    page.screenshot(path=str(SHOTS / "epub_reader.png"))

    # --- 2. TOC lists chapters; tapping jumps --------------------------------
    if page.locator("button[aria-label='Contents']").count() == 0:
        page.mouse.click(195, 60)
        time.sleep(0.8)
    page.locator("button[aria-label='Contents']").click()
    time.sleep(1)
    toc_entries = page.locator("text=Chapter").count()
    page.screenshot(path=str(SHOTS / "epub_toc.png"))
    # tap the 4th visible TOC row (past cover/front matter)
    rows = page.locator("[data-epubchapter]")
    entry = page.locator("button:has-text('Chapter')").nth(2)
    if entry.count() == 0:
        entry = page.locator("button", has_text="Chapter").first
    entry.click()
    time.sleep(2)
    chap_after = page.locator("input[aria-label='Page number']").input_value()
    print("2. toc entries:", toc_entries, "| jumped to chapter:", chap_after,
          "=>", "PASS" if toc_entries > 3 and int(chap_after) > 1 else "FAIL")
    ok &= toc_entries > 3 and int(chap_after) > 1

    # --- 3. reload resumes ---------------------------------------------------
    time.sleep(2.5)  # progress persist
    page.reload()
    page.wait_for_selector("text=Resume reading", timeout=60000)
    page.locator("text=Resume reading").click()
    page.wait_for_selector("[data-epubchapter]", timeout=60000)
    time.sleep(2)
    if page.locator("input[aria-label='Page number']").count() == 0:
        page.mouse.click(195, 60)
        time.sleep(0.8)
    chap_resumed = page.locator("input[aria-label='Page number']").input_value()
    print("3. resumed at chapter:", chap_resumed, "=>",
          "PASS" if chap_resumed == chap_after else "FAIL")
    ok &= chap_resumed == chap_after

    # --- 4. dictionary double-click ------------------------------------------
    spot = page.evaluate("""() => {
      for (const host of document.querySelectorAll("[data-epubchapter] p")) {
        for (const node of host.childNodes) {
          if (node.nodeType !== 3) continue;
          const m = /[A-Za-z]{6,}/.exec(node.textContent);
          if (!m) continue;
          const r = document.createRange();
          r.setStart(node, m.index); r.setEnd(node, m.index + m[0].length);
          const b = r.getBoundingClientRect();
          if (b.top > 120 && b.top < 640) return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        }
      }
      return null;
    }""")
    page.mouse.dblclick(spot["x"], spot["y"])
    time.sleep(2)
    senses = page.locator("[data-defcard] ol li").count()
    print("4. dictionary senses:", senses, "=>", "PASS" if senses > 0 else "FAIL")
    ok &= senses > 0
    page.mouse.click(200, 800)
    time.sleep(0.8)

    # --- 4b. internal links: tap a Contents-page link → chapter jump ---------
    page.locator("input[aria-label='Page number']").fill("8")  # the Contents chapter
    time.sleep(2)
    links = page.locator("[data-epubchapter] [data-el]").count()
    if links > 0:
        page.locator("[data-epubchapter] [data-el]").nth(5).click()
        time.sleep(1.5)
        after = page.locator("input[aria-label='Page number']").input_value()
        print("4b. internal links:", links, "| landed on chapter:", after,
              "=>", "PASS" if after != "8" else "FAIL")
        ok &= after != "8"
    else:
        print("4b. internal links: none found on Contents page => FAIL")
        ok = False

    # --- 5. theme switch recolors --------------------------------------------
    if page.locator("button[aria-label='Reading settings']").count() == 0:
        page.mouse.click(195, 60)
        time.sleep(0.8)
    page.locator("button[aria-label='Reading settings']").click()
    time.sleep(0.8)
    page.locator("button[aria-label='Soft Dark theme']").click()
    time.sleep(1)
    bg = page.evaluate("() => getComputedStyle(document.querySelector('[data-textreader]')).backgroundColor")
    print("5. Soft Dark bg:", bg, "=>", "PASS" if bg.startswith("rgb(23,") or "rgb(22" in bg or "rgb(24" in bg else "FAIL")
    ok &= "rgb(2" in bg  # dark ground
    page.screenshot(path=str(SHOTS / "epub_dark.png"))
    ctx.close()

    # --- 6. corpus smoke ------------------------------------------------------
    for path_ in CORPUS:
        c = browser.new_context(viewport={"width": 390, "height": 844})
        pg = c.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)[:120]))
        pg.goto("http://localhost:5173")
        pg.locator("input[type=file]").first.set_input_files(path_)
        try:
            pg.wait_for_selector("[data-epubchapter]", timeout=60000)
            time.sleep(1.5)
            n = pg.locator("[data-epubchapter] p, [data-epubchapter] div, [data-epubchapter] img").count()
            name = Path(path_).stem[:28]
            print(f"6. {name}: blocks={n}", "=> PASS" if n > 0 and not errs else f"=> FAIL {errs[:1]}")
            ok &= n > 0 and not errs
        except Exception as e:
            print(f"6. {Path(path_).stem[:28]}: FAILED to open — {str(e)[:80]}")
            ok = False
        c.close()

    browser.close()

print("ALL PASS" if ok else "SOMETHING FAILED")
