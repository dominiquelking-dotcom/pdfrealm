import fs from 'fs';
import path from 'path';

function exists(p){
  try { fs.accessSync(p); return true; } catch { return false; }
}

function findFile(candidates){
  for (const p of candidates) if (exists(p)) return p;
  return null;
}

function patchIndexHtml(filePath){
  let s = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  // 1) Normalize Unlock button styles (btn-outline -> btn-secondary) for legacy tools
  const unlockIds = ['repairUnlockBtn','blankUnlockBtn','resizeUnlockBtn','textUnlockBtn'];
  for (const id of unlockIds){
    const re = new RegExp(`id=\"${id}\"\\s+class=\"btn\\s+btn-outline\"`, 'g');
    if (re.test(s)) {
      s = s.replace(re, `id=\"${id}\" class=\"btn btn-secondary\"`);
      changed = true;
    }
  }

  // 2) Upgrade legacy preview-card blocks (Repair / Blank / Resize) to viewer-card
  function upgradePreviewCard({frameId, placeholderId, iframeTitle}){
    // Skip if already upgraded
    if (s.includes(`iframe id=\"${frameId}\"`) && s.includes(`data-popout=\"${frameId}\"`)) {
      // already has explicit popout button; still may be viewer-card already
    }

    const re = new RegExp(
      `<div class=\"card\\s+preview-card\">\\s*` +
        `<div class=\"preview-title\">Preview<\\/div>\\s*` +
        `<div class=\"preview-wrap\">\\s*` +
          `<div id=\"${placeholderId}\" class=\"preview-placeholder\">[\\s\\S]*?<\\/div>\\s*` +
          `<iframe id=\"${frameId}\" class=\"preview-frame\" title=\"${iframeTitle}\"><\\/iframe>\\s*` +
        `<\\/div>\\s*` +
      `<\\/div>`,
      'm'
    );

    if (!re.test(s)) return false;

    const replacement =
`<div class=\"card viewer-card\">\n                <div class=\"viewer-top\">\n                  <div class=\"viewer-title\">Preview</div>\n                  <div class=\"viewer-tools\"></div>\n                </div>\n                <div class=\"viewer-wrapper\" style=\"overflow:hidden;\">\n                  <div id=\"${placeholderId}\" class=\"placeholder\">Upload a PDF to preview it here.</div>\n                  <iframe id=\"${frameId}\" title=\"${iframeTitle}\" style=\"position:relative; top:-64px; height:calc(100% + 64px);\"></iframe>\n                </div>\n              </div>`;

    s = s.replace(re, replacement);
    return true;
  }

  const upgradedRepair = upgradePreviewCard({
    frameId: 'repairPreviewFrame',
    placeholderId: 'repairPreviewPlaceholder',
    iframeTitle: 'Repair preview'
  });
  const upgradedBlank = upgradePreviewCard({
    frameId: 'blankPreviewFrame',
    placeholderId: 'blankPreviewPlaceholder',
    iframeTitle: 'Blank pages preview'
  });
  const upgradedResize = upgradePreviewCard({
    frameId: 'resizePreviewFrame',
    placeholderId: 'resizePreviewPlaceholder',
    iframeTitle: 'Resize preview'
  });

  if (upgradedRepair || upgradedBlank || upgradedResize) changed = true;

  // 3) Add Compare unlock UI (PDF A + PDF B)
  if (!s.includes('id="comparePasswordA"')) {
    const marker = '<input id="compareFileA" type="file" accept="application/pdf" />';
    if (s.includes(marker)) {
      const insert = `${marker}\n\n                <div style=\"display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:10px;\">\n                  <div style=\"flex:1;min-width:220px;\">\n                    <label for=\"comparePasswordA\">Password (if encrypted)</label>\n                    <input id=\"comparePasswordA\" type=\"password\" placeholder=\"Password for PDF A\" autocomplete=\"off\" />\n                  </div>\n                  <div>\n                    <button id=\"compareUnlockABtn\" class=\"btn btn-secondary\" type=\"button\">Decrypt / Unlock</button>\n                  </div>\n                </div>`;
      s = s.replace(marker, insert);
      changed = true;
    }
  }

  if (!s.includes('id="comparePasswordB"')) {
    const marker = '<input id="compareFileB" type="file" accept="application/pdf" />';
    if (s.includes(marker)) {
      const insert = `${marker}\n\n                <div style=\"display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:10px;\">\n                  <div style=\"flex:1;min-width:220px;\">\n                    <label for=\"comparePasswordB\">Password (if encrypted)</label>\n                    <input id=\"comparePasswordB\" type=\"password\" placeholder=\"Password for PDF B\" autocomplete=\"off\" />\n                  </div>\n                  <div>\n                    <button id=\"compareUnlockBBtn\" class=\"btn btn-secondary\" type=\"button\">Decrypt / Unlock</button>\n                  </div>\n                </div>`;
      s = s.replace(marker, insert);
      changed = true;
    }
  }

  // 4) Replace Pop-out viewer helper with a universal version
  const popoutComment = '<!-- Pop-out viewer helper -->';
  const idx = s.indexOf(popoutComment);
  if (idx !== -1) {
    const scriptStart = s.indexOf('<script', idx);
    const scriptEnd = s.indexOf('</script>', scriptStart);
    if (scriptStart !== -1 && scriptEnd !== -1) {
      const before = s.slice(0, idx);
      const after = s.slice(scriptEnd + '</script>'.length);

      const newBlock = `${popoutComment}\n    <script>\n      (function () {\n        // Auto-add Pop-out buttons to viewer-card previews (iframe/img/canvas)\n        function ensurePopoutButtonFor(card, targetId) {\n          if (!card || !targetId) return;\n          try {\n            if (card.querySelector('[data-popout="' + targetId + '"]')) return;\n\n            var top = card.querySelector('.viewer-top');\n            if (!top) return;\n\n            var container = top.querySelector('.viewer-tools');\n            if (!container) {\n              // Prefer appending into an existing control row (e.g., Rotate/Delete), otherwise create viewer-tools\n              var kids = top.children || [];\n              if (kids.length >= 2 && kids[kids.length - 1] && kids[kids.length - 1].appendChild) {\n                container = kids[kids.length - 1];\n              } else {\n                container = document.createElement('div');\n                container.className = 'viewer-tools';\n                top.appendChild(container);\n              }\n            }\n\n            var b = document.createElement('button');\n            b.className = 'btn btn-secondary';\n            b.type = 'button';\n            b.textContent = 'Pop-out';\n            b.setAttribute('data-popout', targetId);\n            container.appendChild(b);\n          } catch (_) {}\n        }\n\n        function autoWirePopouts() {\n          try {\n            var cards = document.querySelectorAll('.viewer-card');\n            cards.forEach(function (card) {\n              // 1) iframe previews (Merge/Split/etc)\n              var iframe = card.querySelector('iframe[id]');\n              if (iframe && iframe.id) {\n                ensurePopoutButtonFor(card, iframe.id);\n                return;\n              }\n\n              // 2) image previews (Delete / Rotate)\n              var img = card.querySelector('img[id]');\n              if (img && img.id) {\n                if (img.id === 'deletePreviewImg' || img.id === 'rotatePreviewImg') {\n                  ensurePopoutButtonFor(card, img.id);\n                }\n                return;\n              }\n\n              // 3) composite canvas previews (Quick Sign / Redact)\n              if (card.querySelector('#qsCanvasShell')) {\n                ensurePopoutButtonFor(card, 'qsCanvasShell');\n                return;\n              }\n              if (card.querySelector('#redactCanvasShell')) {\n                ensurePopoutButtonFor(card, 'redactCanvasShell');\n                return;\n              }\n            });\n          } catch (e) {\n            console.warn('[pdfrealm] popout auto-wire failed', e);\n          }\n        }\n\n        function openBlankPopup() {\n          try {\n            var w = window.open('about:blank', '_blank');\n            if (w) w.opener = null;\n            return w;\n          } catch (_) {\n            return null;\n          }\n        }\n\n        function openUrl(url) {\n          if (!url) return null;\n          try {\n            var w = window.open(url, '_blank');\n            if (w) w.opener = null;\n            return w;\n          } catch (_) {\n            return null;\n          }\n        }\n\n        function elementToPngBlob(el) {\n          return new Promise(function (resolve, reject) {\n            try {\n              if (!el) throw new Error('Missing preview element.');\n\n              // Direct canvas\n              if (el.tagName === 'CANVAS') {\n                el.toBlob(function (blob) {\n                  if (blob) resolve(blob);\n                  else reject(new Error('Failed to export canvas.'));\n                }, 'image/png');\n                return;\n              }\n\n              // Composite canvases inside a wrapper\n              var canvases = Array.prototype.slice.call(el.querySelectorAll('canvas') || []);\n              canvases = canvases.filter(function (c) {\n                var id = String(c.id || '').toLowerCase();\n                return id.indexOf('hit') === -1; // ignore hit/interaction canvas\n              });\n\n              if (!canvases.length) throw new Error('Nothing to pop out yet. Use Preview/Export first.');\n\n              var base = canvases[0];\n              var w = base.width || 1;\n              var h = base.height || 1;\n              canvases.forEach(function (c) {\n                if ((c.width || 0) > w) w = c.width;\n                if ((c.height || 0) > h) h = c.height;\n              });\n\n              var out = document.createElement('canvas');\n              out.width = w;\n              out.height = h;\n              var ctx = out.getContext('2d');\n              ctx.fillStyle = '#ffffff';\n              ctx.fillRect(0, 0, w, h);\n\n              canvases.forEach(function (c) {\n                try { ctx.drawImage(c, 0, 0, w, h); } catch (_) {}\n              });\n\n              // Redact boxes overlay (DOM)\n              var boxLayer = el.querySelector('#redactBoxLayer');\n              if (boxLayer) {\n                var boxes = boxLayer.querySelectorAll('.redact-box');\n                ctx.fillStyle = '#000000';\n                boxes.forEach(function (b) {\n                  var left = parseFloat(b.style.left || '0');\n                  var top = parseFloat(b.style.top || '0');\n                  var bw = parseFloat(b.style.width || '0');\n                  var bh = parseFloat(b.style.height || '0');\n                  if (bw > 0 && bh > 0) ctx.fillRect(left, top, bw, bh);\n                });\n              }\n\n              out.toBlob(function (blob) {\n                if (blob) resolve(blob);\n                else reject(new Error('Failed to export preview.'));\n              }, 'image/png');\n            } catch (e) {\n              reject(e);\n            }\n          });\n        }\n\n        // Click handler for any [data-popout] button\n        document.addEventListener('click', function (e) {\n          var btn = e.target && e.target.closest ? e.target.closest('[data-popout]') : null;\n          if (!btn) return;\n\n          var id = btn.getAttribute('data-popout');\n          var el = document.getElementById(id);\n          if (!el) {\n            alert('Missing preview: ' + id);\n            return;\n          }\n\n          // iframe: open src\n          if (el.tagName === 'IFRAME') {\n            var src = el.getAttribute('src') || '';\n            if (!src) return alert('Nothing to pop out yet. Use Preview/Export first.');\n            var w = openUrl(src);\n            if (!w) alert('Pop-up blocked. Please allow pop-ups for this site.');\n            return;\n          }\n\n          // img: open src\n          if (el.tagName === 'IMG') {\n            var src2 = el.currentSrc || el.src || '';\n            if (!src2) return alert('Nothing to pop out yet. Use Preview/Export first.');\n            var w2 = openUrl(src2);\n            if (!w2) alert('Pop-up blocked. Please allow pop-ups for this site.');\n            return;\n          }\n\n          // canvas/wrapper: render to PNG and open\n          var popup = openBlankPopup();\n          if (popup && popup.document) {\n            popup.document.title = 'Preview';\n            popup.document.body.style.margin = '0';\n            popup.document.body.style.background = '#0b1220';\n            popup.document.body.innerHTML =\n              '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#e5e7eb;padding:18px;">Rendering preview…</div>';\n          }\n\n          elementToPngBlob(el).then(function (blob) {\n            var url = URL.createObjectURL(blob);\n            if (popup) {\n              popup.location = url;\n            } else {\n              var w3 = openUrl(url);\n              if (!w3) alert('Pop-up blocked. Please allow pop-ups for this site.');\n            }\n            setTimeout(function () { try { URL.revokeObjectURL(url); } catch (_) {} }, 60 * 1000);\n          }).catch(function (err) {\n            try { if (popup) popup.close(); } catch (_) {}\n            alert(err && err.message ? err.message : 'Pop-out failed.');\n          });\n        });\n\n        // Auto-wire Pop-out buttons on load\n        if (document.readyState === 'loading') {\n          document.addEventListener('DOMContentLoaded', autoWirePopouts);\n        } else {\n          autoWirePopouts();\n        }\n      })();\n    </script>`;

      if (!s.includes('popout auto-wire failed')) {
        s = before + newBlock + after;
        changed = true;
      }
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, s, 'utf8');
    console.log('[patch] Updated ' + filePath);
  } else {
    console.log('[patch] No changes needed for ' + filePath);
  }
}

function patchAppJs(filePath){
  let s = fs.readFileSync(filePath, 'utf8');
  if (s.includes('compareUnlockABtn') && s.includes('compareUnlockBBtn')) {
    console.log('[patch] Compare unlock already present in ' + filePath);
    return;
  }

  const re = /function initCompare\(\)\s*\{[\s\S]*?\n\}\n\/\/ --------------------------------------------------------------------------------/m;
  if (!re.test(s)) {
    console.error('[patch] Could not find initCompare() block in ' + filePath);
    process.exitCode = 1;
    return;
  }

  const replacement = `function initCompare() {\n  const fileA = $('compareFileA');\n  const fileB = $('compareFileB');\n  const passA = $('comparePasswordA');\n  const passB = $('comparePasswordB');\n  const unlockA = $('compareUnlockABtn');\n  const unlockB = $('compareUnlockBBtn');\n  const runBtn = $('compareRunBtn');\n  const outPre = $('compareResult');\n  const dlTxt = $('compareDownloadTxtBtn');\n  const dlJson = $('compareDownloadJsonBtn');\n\n  if (!fileA || !fileB || !runBtn || !outPre) return;\n\n  let lastTxt = '';\n  let lastJson = null;\n\n  let encA = false;\n  let encB = false;\n  let unlockedA = null;\n  let unlockedB = null;\n\n  function setOutput(t){ outPre.textContent = t || ''; }\n  function setDownloads(enabled){\n    if (dlTxt) dlTxt.disabled = !enabled;\n    if (dlJson) dlJson.disabled = !enabled;\n  }\n  setDownloads(false);\n\n  async function refreshEncryptionStatus() {\n    const a = fileA.files && fileA.files[0];\n    const b = fileB.files && fileB.files[0];\n\n    let msg = '';\n\n    if (a) {\n      encA = await detectEncryptedPdfReliable(a);\n      if (encA) msg += 'PDF A appears encrypted. Enter the password and click "Decrypt / Unlock".\\n';\n    } else {\n      encA = false;\n      unlockedA = null;\n    }\n\n    if (b) {\n      encB = await detectEncryptedPdfReliable(b);\n      if (encB) msg += 'PDF B appears encrypted. Enter the password and click "Decrypt / Unlock".\\n';\n    } else {\n      encB = false;\n      unlockedB = null;\n    }\n\n    if (msg) setOutput(msg.trim());\n    else if (a && b) setOutput('Ready. Click "Compare".');\n    else setOutput('');\n  }\n\n  fileA.addEventListener('change', async () => {\n    unlockedA = null;\n    lastTxt = '';\n    lastJson = null;\n    setDownloads(false);\n    await refreshEncryptionStatus();\n  });\n\n  fileB.addEventListener('change', async () => {\n    unlockedB = null;\n    lastTxt = '';\n    lastJson = null;\n    setDownloads(false);\n    await refreshEncryptionStatus();\n  });\n\n  unlockA?.addEventListener('click', async () => {\n    const f = fileA.files && fileA.files[0];\n    if (!f) return alert('Upload PDF A first.');\n    const pw = String(passA?.value || '').trim();\n    if (!pw) return alert('Enter the password for PDF A.');\n\n    try {\n      unlockA.disabled = true;\n      unlockA.textContent = 'Decrypting…';\n      unlockedA = await decryptPdfToFile(f, pw);\n      encA = false;\n      lastTxt = '';\n      lastJson = null;\n      setDownloads(false);\n      setOutput('PDF A decrypted. Upload PDF B (if needed), then click "Compare".');\n    } catch (e) {\n      console.error('[pdfrealm] compare unlock A error', e);\n      alert(String(e?.message || e));\n    } finally {\n      unlockA.disabled = false;\n      unlockA.textContent = 'Decrypt / Unlock';\n    }\n  });\n\n  unlockB?.addEventListener('click', async () => {\n    const f = fileB.files && fileB.files[0];\n    if (!f) return alert('Upload PDF B first.');\n    const pw = String(passB?.value || '').trim();\n    if (!pw) return alert('Enter the password for PDF B.');\n\n    try {\n      unlockB.disabled = true;\n      unlockB.textContent = 'Decrypting…';\n      unlockedB = await decryptPdfToFile(f, pw);\n      encB = false;\n      lastTxt = '';\n      lastJson = null;\n      setDownloads(false);\n      setOutput('PDF B decrypted. Upload PDF A (if needed), then click "Compare".');\n    } catch (e) {\n      console.error('[pdfrealm] compare unlock B error', e);\n      alert(String(e?.message || e));\n    } finally {\n      unlockB.disabled = false;\n      unlockB.textContent = 'Decrypt / Unlock';\n    }\n  });\n\n  async function extractTexts(pdfjs, file) {\n    const buf = await file.arrayBuffer();\n    const doc = await pdfjs.getDocument({ data: buf }).promise;\n    const pages = doc.numPages;\n    const texts = [];\n    for (let i = 1; i <= pages; i++) {\n      const page = await doc.getPage(i);\n      const tc = await page.getTextContent();\n      const t = (tc.items || []).map(it => (it && it.str) ? String(it.str) : '').join(' ');\n      texts.push(t.replace(/\\s+/g, ' ').trim());\n    }\n    return { pages, texts };\n  }\n\n  runBtn.addEventListener('click', async () => {\n    const a = fileA.files && fileA.files[0];\n    const b = fileB.files && fileB.files[0];\n    if (!a || !b) return alert('Upload both PDF A and PDF B.');\n\n    if (encA && !unlockedA) return alert('PDF A is encrypted. Decrypt / Unlock it first.');\n    if (encB && !unlockedB) return alert('PDF B is encrypted. Decrypt / Unlock it first.');\n\n    const pdfjs = await __pdfrealmGetPdfJsCached();\n    if (!pdfjs) return alert('PDF.js failed to load. Try again or check your network.');\n\n    runBtn.disabled = true;\n    runBtn.dataset._label = runBtn.dataset._label || runBtn.textContent;\n    runBtn.textContent = 'Comparing…';\n    setDownloads(false);\n    setOutput('');\n\n    try {\n      const A = await extractTexts(pdfjs, unlockedA || a);\n      const B = await extractTexts(pdfjs, unlockedB || b);\n\n      const max = Math.max(A.pages, B.pages);\n      const diffs = [];\n      let sameCount = 0;\n\n      for (let i = 0; i < max; i++) {\n        const ta = A.texts[i] ?? '';\n        const tb = B.texts[i] ?? '';\n        const same = ta === tb;\n        if (same) sameCount++;\n        else {\n          diffs.push({\n            page: i + 1,\n            aSnippet: ta.slice(0, 400),\n            bSnippet: tb.slice(0, 400),\n          });\n        }\n      }\n\n      let summary = '';\n      summary += 'Compared ' + A.pages + ' vs ' + B.pages + ' pages.\\n';\n      summary += 'Same pages: ' + sameCount + '/' + max + '\\n';\n      summary += 'Different pages: ' + diffs.length + '/' + max + '\\n\\n';\n\n      if (!diffs.length) summary += 'No differences found.';\n      else {\n        summary += diffs.map(d => {\n          return (\n            '--- Page ' + d.page + ' ---\\n' +\n            'A: ' + (d.aSnippet || '(empty)') + '\\n' +\n            'B: ' + (d.bSnippet || '(empty)')\n          );\n        }).join('\\n\\n');\n      }\n\n      lastTxt = summary;\n      lastJson = {\n        aPages: A.pages,\n        bPages: B.pages,\n        samePages: sameCount,\n        differentPages: diffs.length,\n        diffs,\n      };\n\n      setOutput(summary);\n      setDownloads(true);\n    } catch (e) {\n      console.error('[pdfrealm] compare error', e);\n      alert(String(e?.message || e));\n    } finally {\n      runBtn.disabled = false;\n      runBtn.textContent = runBtn.dataset._label || 'Compare';\n    }\n  });\n\n  dlTxt?.addEventListener('click', () => {\n    if (!lastTxt) return;\n    downloadBlob(new Blob([lastTxt], { type: 'text/plain;charset=utf-8' }), 'pdfrealm-compare.txt');\n  });\n\n  dlJson?.addEventListener('click', () => {\n    if (!lastJson) return;\n    downloadBlob(new Blob([JSON.stringify(lastJson, null, 2)], { type: 'application/json;charset=utf-8' }), 'pdfrealm-compare.json');\n  });\n\n  // Initial status (if inputs are already pre-filled by the browser)\n  refreshEncryptionStatus();\n}\n// --------------------------------------------------------------------------------`;

  s = s.replace(re, replacement);
  fs.writeFileSync(filePath, s, 'utf8');
  console.log('[patch] Updated ' + filePath);
}

function main(){
  const root = process.cwd();
  const htmlPath = findFile([
    path.join(root, 'public', 'index.html'),
    path.join(root, 'index.html'),
  ]);
  const jsPath = findFile([
    path.join(root, 'public', 'app.js'),
    path.join(root, 'app.js'),
  ]);

  if (!htmlPath) {
    console.error('[patch] Could not find public/index.html (or index.html)');
    process.exit(1);
  }
  if (!jsPath) {
    console.error('[patch] Could not find public/app.js (or app.js)');
    process.exit(1);
  }

  patchIndexHtml(htmlPath);
  patchAppJs(jsPath);
}

main();
