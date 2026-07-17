# P0 polish pair, verified end-to-end:
#   1. Text Mode spot-check: long-press a reflowed paragraph -> a peek overlay
#      shows the recolored source page region; tapping dismisses it and the
#      chrome doesn't toggle underneath.
#   2. Scroll-mode pinch: a live CSS transform tracks the fingers DURING the
#      gesture (the "feels live" fix), and release commits the zoom (strip
#      widens, transform cleared).
# Needs `npm run dev` on :5173.
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

CHROME = str(next(Path.home().glob(
    "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")))
PDF = str(Path.home() / "Documents/Hobby/Books/Dungeon Crawler Carl.pdf")

def open_settings(page):
    for _ in range(4):
        if page.locator("button[aria-label='Reading settings']").count() == 0:
            page.mouse.click(2, 400)
            time.sleep(0.7)
        try:
            page.locator("button[aria-label='Reading settings']").click(timeout=2500)
            return
        except Exception:
            continue

def set_mode(page, mode):
    open_settings(page)
    time.sleep(0.8)
    page.locator(f"button:text-is('{mode}')").click()
    time.sleep(0.5)
    page.locator("button[aria-label='Close settings']").click()
    time.sleep(1.5)

ok = True
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME)
    ctx = browser.new_context(viewport={"width": 390, "height": 844},
                              device_scale_factor=2, has_touch=True)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))
    page.goto("http://localhost:5173")
    page.locator("input[type=file]").first.set_input_files(PDF)
    page.wait_for_selector("button[aria-label='Reading settings']", timeout=120000)
    time.sleep(2)

    # --- 1. Text Mode spot-check peek ----------------------------------------
    set_mode(page, "text")
    page.wait_for_selector("[data-textreader]", timeout=30000)
    # Page 1 is the cover (an image item); scroll until real paragraphs load.
    for _ in range(20):
        if page.locator("p[data-blk]").count() >= 3:
            break
        page.evaluate("document.querySelector('[data-textreader]').scrollBy(0, 2000)")
        time.sleep(1.2)
    paras = page.locator("p[data-blk]").count()
    chrome_before = page.locator("button[aria-label='Reading settings']").count()
    target = page.locator("p[data-blk]").nth(2)
    target.scroll_into_view_if_needed()
    time.sleep(0.5)
    box = target.bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + min(box["height"] / 2, 300))
    page.mouse.down()
    time.sleep(0.8)  # long-press fires at 450ms
    opened = page.locator("[data-peek]").count()
    page.mouse.up()
    time.sleep(0.3)
    caption = page.locator("[data-peek] >> text=/Original — page \\d+/").count()
    # The peek renders the recolored crop async; wait for the canvas.
    has_canvas = False
    for _ in range(10):
        if page.locator("[data-peek] canvas").count() > 0:
            has_canvas = True
            break
        time.sleep(0.5)
    chrome_after = page.locator("button[aria-label='Reading settings']").count()
    page.locator("[data-peek]").click()
    time.sleep(0.4)
    closed = page.locator("[data-peek]").count() == 0
    print("1. peek — paras:", paras, "| opens on hold:", opened == 1,
          "| caption:", caption == 1, "| canvas:", has_canvas,
          "| chrome stable:", chrome_before == chrome_after,
          "| closes on tap:", closed, "=>",
          "PASS" if paras >= 3 and opened == 1 and caption == 1 and has_canvas
          and chrome_before == chrome_after and closed else "FAIL")
    ok &= paras >= 3 and opened == 1 and caption == 1 and has_canvas and closed

    # --- 2. Scroll-mode live pinch -------------------------------------------
    set_mode(page, "scroll")
    page.wait_for_selector("[data-strip]", timeout=30000)
    time.sleep(2.5)  # let the visible pages render
    w0 = page.evaluate("parseFloat(document.querySelector('[data-strip]').style.width)")

    cdp = ctx.new_cdp_session(page)
    def touch(kind, points):
        cdp.send("Input.dispatchTouchEvent", {
            "type": kind,
            "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(points)],
        })
    # Two fingers spread apart vertically around mid-screen.
    touch("touchStart", [(195, 350), (195, 500)])
    live = ""
    for step in range(1, 9):
        touch("touchMove", [(195, 350 - step * 18), (195, 500 + step * 18)])
        time.sleep(0.03)
        if step == 5:
            live = page.evaluate("document.querySelector('[data-strip]').style.transform")
    touch("touchEnd", [])
    time.sleep(1.0)
    after = page.evaluate("document.querySelector('[data-strip]').style.transform")
    w1 = page.evaluate("parseFloat(document.querySelector('[data-strip]').style.width)")
    time.sleep(1.5)  # debounced repaint lands
    print("2. pinch — live transform:", "scale(" in live,
          f"| width {w0:.0f} -> {w1:.0f}:", w1 > w0 * 1.15,
          "| transform cleared:", after == "", "=>",
          "PASS" if "scale(" in live and w1 > w0 * 1.15 and after == "" else "FAIL")
    ok &= "scale(" in live and w1 > w0 * 1.15 and after == ""

    if errors:
        print("pageerrors:", errors[:3])
        ok = False
    browser.close()

print("ALL PASS" if ok else "SOMETHING FAILED")
