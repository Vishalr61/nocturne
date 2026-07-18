# Dictionary UX, verified end-to-end against PyMuPDF ground truth:
#   1. Exact taps (mouse dblclick at word centers) pick the right word: 100%.
#   2. Finger taps (real touch path via CDP: jittered double-taps with the
#      contact-point-below-target bias) still pick the right word: >= 80%.
#   3. The definition card always fits the viewport — including the tall
#      many-sense card that used to clip off the top — and misses show a
#      "Search the web" action.
# Needs `npm run dev` on :5173. Ground truth is dumped via the patchpdf venv
# (PyMuPDF) on first run.
import json
import random
import subprocess
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

CHROME = str(next(Path.home().glob(
    "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell")))
PDF = str(Path.home() / "Documents/Hobby/Books/DCC/DungeonCrawlerCarl.pdf")
VENV_PY = str(Path.home() / "patchpdf/backend/.venv/bin/python")
GT_FILE = Path(__file__).parent / "shots" / "dict_gt_words.json"
REPO = Path(__file__).resolve().parents[2]

DUMP = """
import json, sys, fitz
doc = fitz.open(sys.argv[1])
out = {}
for pno in [15, 16]:
    page = doc[pno - 1]
    words = []
    for x0, y0, x1, y1, w, *_ in page.get_text("words"):
        w2 = w.strip(".,;:!?\\"'\\u201c\\u201d\\u2018\\u2019()[]")
        if not w2.isalpha() or len(w2) < 4:
            continue
        if y0 < page.rect.height * 0.08 or y1 > page.rect.height * 0.92:
            continue
        words.append({"x": (x0 + x1) / 2, "y": (y0 + y1) / 2, "w": w2})
    out[str(pno)] = {"pw": page.rect.width, "words": words[::3][:20], "all": words}
print(json.dumps(out))
"""

if not GT_FILE.exists():
    GT_FILE.parent.mkdir(exist_ok=True)
    GT_FILE.write_text(subprocess.check_output([VENV_PY, "-c", DUMP, PDF], text=True))
GT = json.loads(GT_FILE.read_text())


def in_dict(word: str) -> bool:
    """Mirror dict.ts's exact + detachment lookup closely enough that a True
    here means the app WILL find it (a False may rarely be wrong — that only
    makes the test pick a different miss word)."""
    w = word.lower()
    morph = json.loads((REPO / "public/dict/en/morph.json").read_text())
    cands = {w, *morph.get(w, [])}
    if w.endswith("s"):
        cands.add(w[:-1])
    if w.endswith(("ses", "xes", "zes", "ches", "shes", "es")):
        cands.add(w[:-2])
    if w.endswith("ies"):
        cands.add(w[:-3] + "y")
    for suf in ("ed", "ing"):
        if w.endswith(suf):
            base = w[: -len(suf)]
            cands.update({base, base + "e"})
            if len(base) >= 3 and base[-1] == base[-2]:
                cands.add(base[:-1])
    if w.endswith("er"):
        cands.update({w[:-2], w[:-1]})
    if w.endswith("est"):
        cands.update({w[:-3], w[:-2]})
    shards = {}
    for c in cands:
        if not c or not c[0].isalpha():
            continue
        k = c[0]
        if k not in shards:
            shards[k] = json.loads((REPO / f"public/dict/en/{k}.json").read_text())
        if c in shards[k]:
            return True
    return False


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
    page.locator("button[aria-label='Reading settings']").click()
    time.sleep(1)
    page.locator("button:text-is('scroll')").click()
    time.sleep(0.5)
    # The ground-truth mapping assumes uncropped pages (Crop tile is behind Customise).
    page.locator("button:has-text('Customise')").click()
    time.sleep(0.8)
    page.locator("button:has-text('Crop')").click()
    time.sleep(0.5)
    page.locator("button[aria-label='Close settings']").click()
    time.sleep(2)
    cdp = ctx.new_cdp_session(page)

    def live_geo():
        return page.evaluate("""() => {
          const strip = document.querySelector('[data-strip]')
          const r = strip.getBoundingClientRect()
          return { left: r.left, top: r.top, width: r.width, slot: r.height / 384 }
        }""")

    # --- 1 & 2: accuracy ------------------------------------------------------
    for jitter, floor, label in [(False, 1.0, "exact taps"), (True, 0.8, "finger taps")]:
        rng = random.Random(42)
        hits = total = 0
        for pno_s, data in GT.items():
            pno = int(pno_s)
            page.evaluate("""(pno) => {
              const strip = document.querySelector('[data-strip]')
              strip.parentElement.scrollTo(0, strip.getBoundingClientRect().height / 384 * (pno - 1))
            }""", pno)
            time.sleep(1.5)
            geo = live_geo()
            scale = geo["width"] / data["pw"]
            for w in data["words"]:
                x = geo["left"] + w["x"] * scale
                y = geo["top"] + (pno - 1) * geo["slot"] + w["y"] * scale
                if y < 60 or y > 780:
                    continue
                if jitter:
                    for _ in range(2):
                        tx = x + max(-9, min(9, rng.gauss(0, 4)))
                        ty = y + max(-4, min(14, rng.gauss(6, 4)))
                        cdp.send("Input.dispatchTouchEvent", {
                            "type": "touchStart", "touchPoints": [{"x": tx, "y": ty, "id": 1}]})
                        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
                        time.sleep(0.12)
                else:
                    page.mouse.dblclick(x, y)
                time.sleep(0.4)
                card = page.locator("[data-defcard]")
                got = card.inner_text(timeout=2000).lower() if card.count() else ""
                total += 1
                hits += w["w"].lower() in got
                page.mouse.click(8, 420)
                time.sleep(0.2)
        acc = hits / max(1, total)
        print(f"{label}: {hits}/{total} = {acc:.0%} =>", "PASS" if acc >= floor else "FAIL")
        ok &= acc >= floor

    # --- 3: card bounds + miss action ----------------------------------------
    page.evaluate("""() => {
      const strip = document.querySelector('[data-strip]')
      strip.parentElement.scrollTo(0, strip.getBoundingClientRect().height / 384 * 14)
    }""")
    time.sleep(2)
    page.mouse.dblclick(250, 420)  # "through": tall many-sense card, opens upward
    time.sleep(0.9)
    box = page.locator("[data-defcard]").bounding_box()
    fits = box and box["y"] >= 0 and box["y"] + box["height"] <= 844
    print(f"tall card bounds: top {box['y']:.0f} bottom {box['y'] + box['height']:.0f} =>",
          "PASS" if fits else "FAIL")
    ok &= bool(fits)
    page.mouse.click(8, 700)
    time.sleep(0.3)

    # A word our shards don't have -> the miss card offers a web search.
    # Scan the FULL word list (not the accuracy sample) so one is always found
    # (page 16 has "Crocs", which no general dictionary carries).
    miss_word = None
    geo = live_geo()
    for pno_s, data in GT.items():
        scale = geo["width"] / data["pw"]
        for w in data["all"]:
            if not in_dict(w["w"]):
                miss_word = (int(pno_s), w, scale)
                break
        if miss_word:
            break
    if miss_word:
        pno, w, scale = miss_word
        page.evaluate("""(pno) => {
          const strip = document.querySelector('[data-strip]')
          strip.parentElement.scrollTo(0, strip.getBoundingClientRect().height / 384 * (pno - 1))
        }""", pno)
        time.sleep(1.5)
        geo = live_geo()
        page.mouse.dblclick(geo["left"] + w["x"] * scale,
                            geo["top"] + (pno - 1) * geo["slot"] + w["y"] * scale)
        time.sleep(1.2)
        web = page.locator("[data-defcard] button:has-text('Search the web')").count()
        print(f"miss card ('{w['w']}') offers web search:", "PASS" if web == 1 else "FAIL")
        ok &= web == 1
    else:
        print("miss card: no out-of-dictionary word on test pages (skipped)")

    if errors:
        print("pageerrors:", errors[:3])
        ok = False
    browser.close()

print("ALL PASS" if ok else "SOMETHING FAILED")
