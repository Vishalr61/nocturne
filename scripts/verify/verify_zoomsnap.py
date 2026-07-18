# Zoom detents in scroll mode, verified end-to-end:
#   1. A deliberate deep pinch (→ ~2.3x) commits as-is, no snap.
#   2. Pinching back to NEAR fit (within 12%) lands on exactly 1.0 and fires
#      the haptic tick (navigator.vibrate spied).
#   3. Landscape: fit-page is height-bound, so fill-width is a second detent —
#      releasing near it lands the strip at exactly the available width.
# Needs `npm run dev` on :5173.
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

CHROME = str(next(Path.home().glob(
    "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")))
PDF = str(Path.home() / "Documents/Hobby/Books/DCC/DungeonCrawlerCarl.pdf")

VIBRATE_SPY = "navigator.vibrate = () => { window.__buzz = (window.__buzz || 0) + 1; return true }"


def load_scroll(ctx, page):
    page.goto("http://localhost:5173")
    page.locator("input[type=file]").first.set_input_files(PDF)
    page.wait_for_selector("button[aria-label='Reading settings']", timeout=120000)
    time.sleep(2)
    page.locator("button[aria-label='Reading settings']").click()
    time.sleep(1)
    page.locator("button:text-is('scroll')").click()
    time.sleep(0.5)
    page.locator("button[aria-label='Close settings']").click()
    time.sleep(2.5)
    return ctx.new_cdp_session(page)


def pinch(cdp, mid_x, y1, y2, ratio, steps=8):
    """Two vertical fingers moving so the final distance is ratio × initial."""
    d0 = y2 - y1
    c = (y1 + y2) / 2
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [
        {"x": mid_x, "y": y1, "id": 0}, {"x": mid_x, "y": y2, "id": 1}]})
    for s in range(1, steps + 1):
        d = d0 * (1 + (ratio - 1) * s / steps)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [
            {"x": mid_x, "y": c - d / 2, "id": 0}, {"x": mid_x, "y": c + d / 2, "id": 1}]})
        time.sleep(0.03)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    time.sleep(1.2)


def strip_width(page):
    return page.evaluate("parseFloat(document.querySelector('[data-strip]').style.width)")


ok = True
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME)

    # --- portrait: deep zoom holds, near-fit release snaps to exactly 1 ------
    ctx = browser.new_context(viewport={"width": 390, "height": 844},
                              device_scale_factor=2, has_touch=True)
    page = ctx.new_page()
    page.add_init_script(VIBRATE_SPY)
    page.on("pageerror", lambda e: print("pageerror:", str(e)[:200]))
    cdp = load_scroll(ctx, page)
    w_fit = strip_width(page)

    pinch(cdp, 195, 350, 500, 2.3)
    w_deep = strip_width(page)
    deep_ok = w_deep > w_fit * 2.0  # committed, unsnapped
    time.sleep(1.5)
    pinch(cdp, 195, 350, 500, 1.05 / (w_deep / w_fit))  # back to ~1.05x fit
    w_back = strip_width(page)
    buzz = page.evaluate("window.__buzz || 0")
    snap_ok = abs(w_back - w_fit) < 1
    print(f"1. deep pinch holds: {w_fit:.0f} -> {w_deep:.0f} =>",
          "PASS" if deep_ok else "FAIL")
    print(f"2. near-fit release snaps: {w_back:.0f} (fit {w_fit:.0f}) | haptic: {buzz} =>",
          "PASS" if snap_ok and buzz >= 1 else "FAIL")
    ok &= deep_ok and snap_ok and buzz >= 1
    ctx.close()

    # --- landscape: fill-width is a second detent ----------------------------
    ctx2 = browser.new_context(viewport={"width": 844, "height": 390},
                               device_scale_factor=2, has_touch=True)
    pg = ctx2.new_page()
    pg.add_init_script(VIBRATE_SPY)
    pg.on("pageerror", lambda e: print("pageerror:", str(e)[:200]))
    cdp2 = load_scroll(ctx2, pg)
    w0 = strip_width(pg)
    avail = pg.evaluate(
        "document.querySelector('[data-strip]').parentElement.clientWidth - 16")
    width_fill = avail / w0
    if width_fill > 1.05:
        pinch(cdp2, 420, 120, 280, width_fill * 0.95)  # release near the detent
        w1 = strip_width(pg)
        fill_ok = abs(w1 - avail) < 1
        print(f"3. landscape fill-width detent: {w1:.0f} (avail {avail:.0f}) =>",
              "PASS" if fill_ok else "FAIL")
        ok &= fill_ok
    else:
        print("3. landscape: fit already width-bound here (skipped)")
    ctx2.close()
    browser.close()

print("ALL PASS" if ok else "SOMETHING FAILED")
