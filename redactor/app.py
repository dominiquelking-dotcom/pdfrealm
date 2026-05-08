from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional, Any, Dict
import base64
import re
import fitz  # PyMuPDF

app = FastAPI()

class BBoxN(BaseModel):
    x: float
    y: float
    w: float
    h: float

class Redaction(BaseModel):
    page: int           # 1-based
    bboxN: BBoxN

class RedactReq(BaseModel):
    pdf_b64: str
    redactions: List[Redaction]
    fill_rgb: Optional[List[float]] = None   # [0..1,0..1,0..1]
    remove_images: Optional[bool] = True

@app.post("/redact")
def redact(req: RedactReq) -> Dict[str, Any]:
    try:
        pdf_bytes = base64.b64decode(req.pdf_b64.encode("utf-8"))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"bad pdf_b64: {e}")

    if not req.redactions:
        raise HTTPException(status_code=400, detail="no redactions provided")

    fill = req.fill_rgb or [0.0, 0.0, 0.0]
    if len(fill) != 3:
        fill = [0.0, 0.0, 0.0]

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"cannot open pdf: {e}")

    by_page: Dict[int, List[BBoxN]] = {}
    for r in req.redactions:
        by_page.setdefault(r.page, []).append(r.bboxN)

    for page_num, boxes in by_page.items():
        if page_num < 1 or page_num > doc.page_count:
            continue
        page = doc.load_page(page_num - 1)
        pr = page.rect
        W, H = pr.width, pr.height

        for b in boxes:
            x0 = max(0.0, min(W, b.x * W))
            y0 = max(0.0, min(H, b.y * H))
            x1 = max(0.0, min(W, (b.x + b.w) * W))
            y1 = max(0.0, min(H, (b.y + b.h) * H))
            rect = fitz.Rect(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
            page.add_redact_annot(rect, fill=fill)

        try:
            if req.remove_images:
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_REMOVE)
            else:
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
        except Exception:
            try:
                page.apply_redactions()
            except Exception as e:
                doc.close()
                raise HTTPException(status_code=500, detail=f"apply_redactions failed: {e}")

    try:
        out_bytes = doc.tobytes(garbage=4, deflate=True, clean=True)
    except Exception as e:
        doc.close()
        raise HTTPException(status_code=500, detail=f"save failed: {e}")

    doc.close()
    return {"ok": True, "out_pdf_b64": base64.b64encode(out_bytes).decode("utf-8"), "bytes": len(out_bytes)}

class ReplaceTextReq(BaseModel):
    pdf_b64: str
    find: str
    replace: str
    pages: Optional[List[int]] = None     # 1-based pages; null/empty => all
    match_case: Optional[bool] = False
    whole_word: Optional[bool] = False
    fill_rgb: Optional[List[float]] = None
    text_rgb: Optional[List[float]] = None

@app.post("/replace_text")
def replace_text(req: ReplaceTextReq) -> Dict[str, Any]:
    try:
        pdf_bytes = base64.b64decode(req.pdf_b64.encode("utf-8"))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"bad pdf_b64: {e}")

    find = (req.find or "").strip()
    if not find:
        raise HTTPException(status_code=400, detail="missing find")
    repl = req.replace or ""

    fill = req.fill_rgb or [1.0, 1.0, 1.0]
    if len(fill) != 3:
        fill = [1.0, 1.0, 1.0]

    text_rgb = req.text_rgb or [0.0, 0.0, 0.0]
    if len(text_rgb) != 3:
        text_rgb = [0.0, 0.0, 0.0]

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"cannot open pdf: {e}")

    if req.pages:
        target = sorted({p for p in req.pages if isinstance(p, int) and 1 <= p <= doc.page_count})
    else:
        target = list(range(1, doc.page_count + 1))

    flags = 0
    try:
        if not req.match_case:
            flags |= fitz.TEXT_IGNORECASE
    except Exception:
        pass

    whole_word = bool(req.whole_word)
    replaced_count = 0
    replaced_pages = set()

    for pn in target:
        page = doc.load_page(pn - 1)

        try:
            rects = page.search_for(find, flags=flags)
        except Exception:
            rects = page.search_for(find)

        if not rects:
            continue

        if whole_word:
            words = page.get_text("words")
            want = find if req.match_case else find.lower()
            filtered = []
            for r in rects:
                hit_words = []
                for w in words:
                    wr = fitz.Rect(w[0], w[1], w[2], w[3])
                    if wr.intersects(r):
                        hit_words.append(w[4])
                if not hit_words:
                    continue
                joined = " ".join(hit_words)
                cmp = joined if req.match_case else joined.lower()
                if re.search(rf"\b{re.escape(want)}\b", cmp):
                    filtered.append(r)
            rects = filtered

        if not rects:
            continue

        for r in rects:
            try:
                page.add_redact_annot(r, fill=fill)
            except Exception:
                pass

        try:
            page.apply_redactions()
        except Exception:
            continue

        for r in rects:
            fs = max(6, min(48, int(r.height * 0.72)))
            try:
                page.insert_textbox(r, repl, fontsize=fs, fontname="helv", color=text_rgb, align=0)
                replaced_count += 1
                replaced_pages.add(pn)
            except Exception:
                continue

    try:
        out_bytes = doc.tobytes(garbage=4, deflate=True, clean=True)
    except Exception as e:
        doc.close()
        raise HTTPException(status_code=500, detail=f"save failed: {e}")

    doc.close()
    return {"ok": True, "out_pdf_b64": base64.b64encode(out_bytes).decode("utf-8"),
            "bytes": len(out_bytes), "replaced": replaced_count, "pages": sorted(replaced_pages)}

class ReplaceRectReq(BaseModel):
    pdf_b64: str
    page: int
    bboxN: BBoxN
    text: str
    fill_rgb: Optional[List[float]] = None
    text_rgb: Optional[List[float]] = None

@app.post("/replace_rect")
def replace_rect(req: ReplaceRectReq) -> Dict[str, Any]:
    try:
        pdf_bytes = base64.b64decode(req.pdf_b64.encode("utf-8"))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"bad pdf_b64: {e}")

    if req.page < 1:
        raise HTTPException(status_code=400, detail="bad page")

    fill = req.fill_rgb or [1.0, 1.0, 1.0]
    if len(fill) != 3:
        fill = [1.0, 1.0, 1.0]

    text_rgb = req.text_rgb or [0.0, 0.0, 0.0]
    if len(text_rgb) != 3:
        text_rgb = [0.0, 0.0, 0.0]

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"cannot open pdf: {e}")

    if req.page > doc.page_count:
        doc.close()
        raise HTTPException(status_code=400, detail="page out of range")

    page = doc.load_page(req.page - 1)
    pr = page.rect
    W, H = pr.width, pr.height

    b = req.bboxN
    x0 = max(0.0, min(W, b.x * W))
    y0 = max(0.0, min(H, b.y * H))
    x1 = max(0.0, min(W, (b.x + b.w) * W))
    y1 = max(0.0, min(H, (b.y + b.h) * H))
    rect = fitz.Rect(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))

    try:
        page.add_redact_annot(rect, fill=fill)
        page.apply_redactions()
    except Exception as e:
        doc.close()
        raise HTTPException(status_code=500, detail=f"redact/apply failed: {e}")

    fs = max(6, min(64, int(rect.height * 0.72)))
    try:
        page.insert_textbox(rect, req.text or "", fontsize=fs, fontname="helv", color=text_rgb, align=0)
    except Exception as e:
        doc.close()
        raise HTTPException(status_code=500, detail=f"insert_textbox failed: {e}")

    try:
        out_bytes = doc.tobytes(garbage=4, deflate=True, clean=True)
    except Exception as e:
        doc.close()
        raise HTTPException(status_code=500, detail=f"save failed: {e}")

    doc.close()
    return {"ok": True, "out_pdf_b64": base64.b64encode(out_bytes).decode("utf-8"), "bytes": len(out_bytes), "page": req.page}

# ----------------------------
# Hit-test existing text by point (normalized coords)
# ----------------------------
class TextHitReq(BaseModel):
    pdf_b64: str
    page: int          # 1-based
    xN: float
    yN: float

@app.post("/text_hit")
def text_hit(req: TextHitReq) -> Dict[str, Any]:
    try:
        pdf_bytes = base64.b64decode(req.pdf_b64.encode("utf-8"))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"bad pdf_b64: {e}")

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"cannot open pdf: {e}")

    pn = int(req.page)
    if pn < 1 or pn > doc.page_count:
        doc.close()
        raise HTTPException(status_code=400, detail="page out of range")

    page = doc.load_page(pn - 1)
    pr = page.rect
    W, H = pr.width, pr.height

    x = max(0.0, min(W, float(req.xN) * W))
    y = max(0.0, min(H, float(req.yN) * H))

    words = page.get_text("words")  # x0,y0,x1,y1,word,...
    hit = None
    hit_r = None

    # first pass: direct containment
    for w in words:
        r = fitz.Rect(w[0], w[1], w[2], w[3])
        if r.contains(fitz.Point(x, y)):
            hit = w[4]
            hit_r = r
            break

    # fallback: nearest word within a small radius
    if hit is None and words:
        best = None
        best_d2 = None
        for w in words:
            r = fitz.Rect(w[0], w[1], w[2], w[3])
            cx = (r.x0 + r.x1) * 0.5
            cy = (r.y0 + r.y1) * 0.5
            d2 = (cx - x) * (cx - x) + (cy - y) * (cy - y)
            if best_d2 is None or d2 < best_d2:
                best_d2 = d2
                best = (w[4], r)
        # accept only if not crazy far (50 px in page units)
        if best and best_d2 is not None and best_d2 <= (50.0 * 50.0):
            hit, hit_r = best

    if hit is None or hit_r is None:
        doc.close()
        return {"ok": True, "found": False}

    bboxN = {
        "x": float(hit_r.x0 / W),
        "y": float(hit_r.y0 / H),
        "w": float((hit_r.x1 - hit_r.x0) / W),
        "h": float((hit_r.y1 - hit_r.y0) / H),
    }

    doc.close()
    return {"ok": True, "found": True, "page": pn, "text": hit, "bboxN": bboxN}
