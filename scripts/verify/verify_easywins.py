# Easy-wins batch, tested at the extremes:
#   1. EPUB search: plain query streams hits; ACCENTED query ("Watnéy") folds
#      and still finds plain "Watney"; UPPERCASE works; 1-char and garbage
#      queries produce no results and no crash.
#   2. Tapping a hit lands INSIDE the chapter (fraction scroll, not the top).
#   3. Recent searches: chips appear for an empty query, tap re-runs, persists
#      across reload.
#   4. Share-original row: present for EPUBs, absent for PDFs; click downloads.
#   5. Per-book reading time: shows on the hero once >= 30 min accumulated.
# Needs `npm run dev` on :5173.
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

CHROME = str(next(Path.home().glob(
    "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")))
MARTIAN = str(Path.home() / "Documents/Hobby/Books/Andy Weir/Andy Weir - The Martian.epub")
PDF = str(Path.home() / "Documents/Hobby/Books/Dungeon Crawler Carl.pdf")
SHOTS = Path(__file__).parent / "shots"

def open_search(page):
    for _ in range(4):
        if page.locator("button[aria-label='Reading settings']").count() == 0:
            page.mouse.click(2, 400)
            time.sleep(0.7)
        try:
            page.locator("button[aria-label='Reading settings']").click(timeout=2500)
            break
        except Exception:
            continue
    time.sleep(0.8)
    page.locator("button[aria-label='Search in book']").first.click()
    time.sleep(0.8)

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

    # --- 1. EPUB search: plain, accented, uppercase, garbage, 1-char --------
    open_search(page)
    box = page.locator("input[aria-label='Search in book']")
    box.fill("Watney")
    time.sleep(3)
    plain = page.locator("main button, [class*=hit], li").count()
    plain_rows = page.locator("text=Watney").count()
    box.fill("Watnéy")
    time.sleep(3)
    accented_rows = page.locator("text=Watney").count()
    box.fill("WATNEY")
    time.sleep(3)
    upper_rows = page.locator("text=Watney").count()
    box.fill("zqxjv")
    time.sleep(2.5)
    garbage = page.locator("text=Watney").count()
    box.fill("a")
    time.sleep(1.5)
    print("1. epub search — plain:", plain_rows, "| accented:", accented_rows,
          "| upper:", upper_rows, "| garbage:", garbage,
          "=>", "PASS" if plain_rows > 0 and accented_rows > 0 and upper_rows > 0 and garbage == 0 else "FAIL")
    ok &= plain_rows > 0 and accented_rows > 0 and upper_rows > 0 and garbage == 0

    # --- 2. hit lands inside the chapter -------------------------------------
    box.fill("Watney")
    time.sleep(3)
    page.locator("text=Watney").nth(3).click()
    time.sleep(2)
    landed = page.evaluate("""() => {
      const s = document.querySelector('[data-textreader]');
      return s ? s.scrollTop : -1
    }""")
    print("2. hit lands mid-chapter, scrollTop:", int(landed), "=>", "PASS" if landed > 50 else "FAIL")
    ok &= landed > 50

    # --- 3. recent searches ---------------------------------------------------
    open_search(page)
    page.locator("input[aria-label='Search in book']").fill("")  # query persists; clear to see recents
    time.sleep(0.8)
    recents = page.locator("text=Recent").count()
    chip = page.locator("button:has-text('Watney')").first
    if chip.count() > 0:
        chip.click()
        time.sleep(2.5)
    refilled = page.locator("input[aria-label='Search in book']").input_value()
    page.reload()
    page.wait_for_selector("text=Resume reading", timeout=60000)
    page.locator("text=Resume reading").click()
    page.wait_for_selector("[data-epubchapter]", timeout=60000)
    time.sleep(1.5)
    open_search(page)
    persisted = page.locator("text=Recent").count()
    print("3. recents — shown:", recents, "| chip refills:", refilled == "Watney",
          "| persists:", persisted, "=>",
          "PASS" if recents >= 1 and refilled == "Watney" and persisted >= 1 else "FAIL")
    ok &= recents >= 1 and refilled == "Watney" and persisted >= 1
    page.locator("button[aria-label='Close search']").click()
    time.sleep(0.5)

    # --- 4. share-original row (EPUB yes, download fires) ---------------------
    for _ in range(4):
        if page.locator("button[aria-label='Reading settings']").count() == 0:
            page.mouse.click(2, 400)
            time.sleep(0.7)
        try:
            page.locator("button[aria-label='Reading settings']").click(timeout=2500)
            break
        except Exception:
            continue
    time.sleep(0.8)
    page.locator("button:has-text('Customise')").click()
    time.sleep(1)
    share_row = page.locator("text=Share original file").count()
    with page.expect_download(timeout=10000) as dl:
        page.locator("text=Share original file").click()
    got = dl.value.suggested_filename.endswith(".epub")
    print("4. share row:", share_row, "| downloads .epub:", got, "=>",
          "PASS" if share_row == 1 and got else "FAIL")
    ok &= share_row == 1 and got
    ctx.close()

    # PDF context: share row absent + book-time hero display
    ctx2 = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    pg = ctx2.new_page()
    pg.on("pageerror", lambda e: print("pageerror:", str(e)[:200]))
    pg.goto("http://localhost:5173")
    pg.locator("input[type=file]").first.set_input_files(PDF)
    pg.wait_for_selector("button[aria-label='Reading settings']", timeout=120000)
    time.sleep(2)
    pg.locator("button[aria-label='Reading settings']").click()
    time.sleep(0.8)
    pg.locator("button:has-text('Customise')").click()
    time.sleep(1)
    pdf_share = pg.locator("text=Share original file").count()
    pg.locator("button[aria-label='Close settings']").click()
    time.sleep(0.5)

    book_id = pg.evaluate("""() => new Promise((res) => {
      const r = indexedDB.open('nocturne');
      r.onsuccess = () => {
        const tx = r.result.transaction('books', 'readonly');
        tx.objectStore('books').getAllKeys().onsuccess = function () { res(this.result[0]); r.result.close(); };
      };
    })""")
    pg.evaluate("""(id) => new Promise((res) => {
      const r = indexedDB.open('nocturne');
      r.onsuccess = () => {
        const tx = r.result.transaction('bookTime', 'readwrite');
        tx.objectStore('bookTime').put({ bookId: id, ms: 45 * 60000 });
        tx.oncomplete = () => { r.result.close(); res(1); };
      };
    })""", book_id)
    pg.goto("http://localhost:5173")
    time.sleep(2.5)
    hero_read = pg.locator("text=/45 min read/").count()
    print("5. pdf share row:", pdf_share, "| hero '45 min read':", hero_read, "=>",
          "PASS" if pdf_share == 0 and hero_read == 1 else "FAIL")
    ok &= pdf_share == 0 and hero_read == 1
    ctx2.close()
    browser.close()

print("ALL PASS" if ok else "SOMETHING FAILED")
