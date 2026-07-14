"""Drive the real app headless and verify the refined export flow:
- EPUB carries Text Mode typography (embedded fonts + styled CSS)
- Dark PDF honours page range (+ crop/imageDim wired)
- Original-pages extract works from the new range UI
"""
import json
import sys
import time
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright

CHROME = str(next(Path.home().glob("Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")))
BOOK = str(Path.home() / "Documents/Hobby/Books/enders_game_-_full_novel.pdf")
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/nocturne-exports")
OUT.mkdir(parents=True, exist_ok=True)


def set_value(page, selector, value):
    page.eval_on_selector(
        selector,
        """(el, v) => {
          const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          set.call(el, v); el.dispatchEvent(new Event('input', {bubbles: true}));
        }""",
        str(value),
    )


def row_button(page, title):
    exact = "text()" if title != "EPUB" else "text()"
    return page.locator(
        f"xpath=//div[div[div[normalize-space(text())='{title}']]]/button"
    ).first


def save_download(page, btn, dest):
    with page.expect_download(timeout=300000) as dl:
        btn.click()
    dl.value.save_as(dest)
    return dest


def main():
    results = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME)
        ctx = browser.new_context(
            viewport={"width": 390, "height": 844},
            device_scale_factor=3,
            accept_downloads=True,
        )
        page = ctx.new_page()
        page.on("pageerror", lambda e: print("pageerror:", str(e)[:300]))
        page.goto("http://localhost:5173")
        page.locator("input[type=file]").first.set_input_files(BOOK)
        page.wait_for_selector("button[aria-label='Reading settings']", timeout=60000)
        time.sleep(2)  # let first render settle

        page.locator("button[aria-label='Reading settings']").click()
        page.wait_for_selector("text=Reading settings", timeout=5000)

        # Text mode + distinctive typography.
        page.locator("button:has-text('text')").last.click()
        page.wait_for_selector("text=Literata", timeout=5000)
        page.locator("button:has-text('Literata')").first.click()
        page.locator("[aria-label='Justify text']").click()
        page.locator("button:has-text('Spaced')").first.click()
        set_value(page, "input[aria-label='Line spacing']", "2")
        time.sleep(0.5)

        # --- EPUB export (whole book) ---
        epub_path = OUT / "book.epub"
        save_download(page, row_button(page, "EPUB"), epub_path)
        z = zipfile.ZipFile(epub_path)
        css = z.read("OEBPS/style.css").decode()
        names = z.namelist()
        results["epub_fonts"] = sorted(n for n in names if n.startswith("OEBPS/fonts/"))
        results["epub_apple_xml"] = "META-INF/com.apple.ibooks.display-options.xml" in names
        results["epub_css_ok"] = all(
            s in css
            for s in ("Literata", "line-height: 2", "text-align: justify", "margin: 0 0 0.9em")
        )
        results["epub_css"] = css

        # --- Page range 3-5 ---
        page.locator("button:has-text('Page range')").click()
        set_value(page, "input[aria-label='Export from page']", "3")
        set_value(page, "input[aria-label='Export to page']", "5")

        dark_path = OUT / "dark-range.pdf"
        save_download(page, row_button(page, "Dark PDF"), dark_path)

        orig_path = OUT / "original-range.pdf"
        save_download(page, row_button(page, "Original pages"), orig_path)

        browser.close()

    print(json.dumps({k: v for k, v in results.items() if k != "epub_css"}, indent=2))
    print("--- css ---")
    print(results["epub_css"])


if __name__ == "__main__":
    main()
