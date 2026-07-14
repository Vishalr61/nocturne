import re
import time
import zipfile
from pathlib import Path
from playwright.sync_api import sync_playwright

CHROME = str(next(Path.home().glob("Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")))
OUT = Path(__file__).parent / "exports"


def set_value(page, selector, value):
    page.eval_on_selector(
        selector,
        """(el, v) => {
          const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          set.call(el, v); el.dispatchEvent(new Event('input', {bubbles: true}));
        }""",
        str(value),
    )


def export_epub(p, book, dest, rng=None):
    browser = p.chromium.launch(executable_path=CHROME)
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3, accept_downloads=True)
    page = ctx.new_page()
    page.on("pageerror", lambda e: print("pageerror:", str(e)[:200]))
    page.goto("http://localhost:5173")
    page.locator("input[type=file]").first.set_input_files(book)
    page.wait_for_selector("button[aria-label='Reading settings']", timeout=120000)
    time.sleep(2)
    page.locator("button[aria-label='Reading settings']").click()
    page.wait_for_selector("text=Reading settings", timeout=5000)
    if rng:
        page.locator("button:has-text('Page range')").click()
        set_value(page, "input[aria-label='Export from page']", str(rng[0]))
        set_value(page, "input[aria-label='Export to page']", str(rng[1]))
    btn = page.locator("xpath=//div[div[div[normalize-space(text())='EPUB']]]/button").first
    with page.expect_download(timeout=600000) as dl:
        btn.click()
    dl.value.save_as(dest)
    browser.close()


def report(dest):
    z = zipfile.ZipFile(dest)
    names = z.namelist()
    nav = z.read("OEBPS/nav.xhtml").decode()
    titles = re.findall(r'<a href="c\d+\.xhtml">([^<]+)</a>', nav)
    print(dest.name)
    print("  cover:", "OEBPS/cover.jpg" in names, " chapters:", len(titles))
    print("  titles:", titles[:12])


with sync_playwright() as p:
    dcc = OUT / "dcc-merge.epub"
    export_epub(p, str(Path.home() / "Documents/Hobby/Books/Dungeon Crawler Carl.pdf"), dcc, rng=(1, 60))
    report(dcc)
    eg = OUT / "enders-merge.epub"
    export_epub(p, str(Path.home() / "Documents/Hobby/Books/enders_game_-_full_novel.pdf"), eg, rng=(1, 40))
    report(eg)
