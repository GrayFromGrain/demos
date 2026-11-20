// hmi-render.js — draws the HMI screens into a 128×40 framebuffer the way the device firmware would: the Custom Pixel
// bitmap font (pixel-font.js) and pixel icons (hmi-icons/icons.js) exported from DisplaySim.html, and the screen list
// in hmi-screens.js.
// No outline fonts and no editor state: one font size, every glyph and icon on whole pixels.
//
//   const s = HMI.frame("Place in Garment", {t: ms since the screen appeared, caps, textMode, swap});
//   if(s.key !== lastKey){ s.draw(fb); lastKey = s.key; }     // fb: Uint8Array(128*40), 1 = lit
//   s.animated → keep calling while it shows (long text scrolls / steps)
//
// Layouts and timings are DisplaySim's (keep in sync): its LAYOUTS table, the long text (scroll SCROLL_PX px/s with
// padding, or step between two halves every STEP_MS), text centered on its lit pixels, and text-only screens
// centered vertically on their lit rows.
(function(){
  const W = 128, H = 40;

  // ---- Layout settings (what would be constants in the device code) ----
  const CONFIG = {
    centerTextOnly: true,      // text-only screens: lit rows centered on the 40 rows
    scrollPx: 40,              // long text: scroll speed in px/s, 1 px at a time
    stepMs: 1000,              // long text, step mode: each half shows this long
    padL: 2.5 * 2.39,          // long text, scroll mode: space before and after each copy (HMI-Flow's 2.5cqw / 6.7cqw)
    padR: 6.7 * 2.39,
    barStep: 8,                // treatment bars: px between bars
  };

  // ---- Screens: text ({text, cx: ink center, base: baseline}), icons ({icon, pdx: x shift}), bars ({bars: filled}) ----
  // {long:true} is the screen's long text (`text` in hmi-screens.js); it scrolls or steps across the whole width.
  const T = (text, cx, base) => ({text, cx, base});
  const LONG = {cx: W/2, base: 28.28};
  const LAYOUTS = {
    "Off": [],
    "Turn On": [{icon:"logo"}, {icon:"battSmall"}, {bars:2}],
    "Place in Garment": [{long:true}],
    "Waiting for Device": [],
    "Docked into Garment": [T("Ready", 65.19, 28)],
    "Start Treatment": [T("59:59", 54.94, 31), {icon:"battSmall"}, {bars:2}],
    "Custom Treatment": [T("59:59", 54.94, 31), {icon:"battSmall"}, {icon:"customM"}],
    "Treatment Finished": [T("Finished", 64.62, 28)],
    "Battery Low": [{icon:"battOutline"}, T("30%", 87.14, 29.5)],
    "Charger Connected": [{icon:"battOutline", pdx:-9}, T("30%", 71.14, 30), {icon:"bolt"}],
    "Finished Charging": [{icon:"battFull"}, T("100%", 85.59, 30)],
  };
  // Screen list: hmi-screens.js, with the live-only Custom Treatment after Start Treatment (as in DisplaySim)
  const SCREENS = typeof MAIN !== "undefined" ? [...MAIN, ...BATTERY].map(s => ({name: s.name, text: s.text})) : [];
  { const i = SCREENS.findIndex(s => s.name === "Start Treatment"); if(i >= 0) SCREENS.splice(i + 1, 0, {name: "Custom Treatment"}); }

  // ---- Font ----
  const font = () => window.PIXEL_FONT && window.PIXEL_FONT.sizes && window.PIXEL_FONT.sizes.L;
  const glyphCache = new Map();
  function glyph(ch){                                     // {adv, asc, rows, inkL, inkR}; unknown characters draw as "?"
    if(glyphCache.has(ch)) return glyphCache.get(ch);
    const S = font(), g = S && (S.glyphs[ch] || S.glyphs["?"]);
    let out = {adv: 0, rows: [], asc: 0, inkL: null, inkR: null};
    if(g){
      let l = Infinity, r = -Infinity;
      for(const row of g.rows) for(let c = 0; c < row.length; c++) if(row[c] === "#"){ l = Math.min(l, c); r = Math.max(r, c + 1); }
      out = {adv: g.adv, rows: g.rows, asc: S.asc, inkL: isFinite(l) ? l : null, inkR: isFinite(r) ? r : null};
    }
    glyphCache.set(ch, out); return out;
  }
  // Letter spacing is baked into pixel-font.js: letters' advances include it (a glyph's rows may run past its advance
  // when the spacing is negative), so pens just add advances.
  function layout(text){                                  // pens, and the ink's left and right edges
    const items = []; let pen = 0, minX = Infinity, maxX = -Infinity;
    for(const ch of text){
      const g = glyph(ch); items.push([pen, g]);
      if(g.inkL !== null){ minX = Math.min(minX, pen + g.inkL); maxX = Math.max(maxX, pen + g.inkR); }
      pen += g.adv;
    }
    return {items, width: pen, minX: isFinite(minX) ? minX : 0, maxX: isFinite(maxX) ? maxX : 0};
  }
  function inkRows(L, base){                              // [top, bottom] lit rows of a laid-out string on this baseline
    let y0 = Infinity, y1 = -Infinity;
    for(const [, g] of L.items) g.rows.forEach((row, i) => { if(row.includes("#")){ const y = base - g.asc + i; y0 = Math.min(y0, y); y1 = Math.max(y1, y); } });
    return isFinite(y0) ? [y0, y1] : null;
  }
  const centerShift = (L, base) => { const r = inkRows(L, base); return r ? Math.floor((H - (r[1] - r[0] + 1))/2) - r[0] : 0; };
  function drawString(fb, L, left, base){                 // glyph row i sits on y = base − asc + i (baseline under row asc)
    for(const [pen, g] of L.items) g.rows.forEach((row, i) => {
      const y = base - g.asc + i; if(y < 0 || y >= H) return;
      for(let c = 0; c < row.length; c++) if(row[c] === "#"){ const x = left + pen + c; if(x >= 0 && x < W) fb[y*W + x] = 1; }
    });
  }
  const drawCentered = (fb, L, cx, base) => drawString(fb, L, Math.round(cx - (L.minX + L.maxX)/2), Math.round(base));
  function drawIcon(fb, name, dx = 0){
    // hmi-icons/icons.js (the icons' own file, exported with the PNGs); older font files carried them inside
    const icons = window.HMI_ICONS || (window.PIXEL_FONT && window.PIXEL_FONT.icons), ic = icons && icons[name]; if(!ic) return;
    ic.rows.forEach((row, r) => { for(let c = 0; c < row.length; c++) if(row[c] === "#"){
      const x = ic.x + dx + c, y = ic.y + r; if(x >= 0 && x < W && y >= 0 && y < H) fb[y*W + x] = 1; } });
  }
  function splitText(t){                                  // two halves at the space nearest the middle
    const sp = [...t.matchAll(/ /g)].map(m => m.index);
    if(!sp.length) return [t, t];
    const at = sp.reduce((b, x) => Math.abs(x - t.length/2) < Math.abs(b - t.length/2) ? x : b, sp[0]);
    return [t.slice(0, at), t.slice(at + 1)];
  }

  // ---- A screen at time t ----
  // opts: t (ms since it appeared), caps (All caps), textMode ("scroll" | "step"),
  //       swap ([[regex, text], …] applied to the screen's text before caps: live timer, wording, Dock Left, Paused)
  function frame(name, {t = 0, caps = false, textMode = "scroll", swap = []} = {}){
    // A frame's timestamp can be a moment before the screen appeared: never let the time go negative (in step mode
    // that would pick half −1, which doesn't exist)
    t = Math.max(0, t || 0);
    const st = SCREENS.find(s => s.name === name) || {name}, lay = LAYOUTS[name] || [];
    const fix = text => { for(const [a, b] of swap) text = text.replace(new RegExp(a, "g"), b); return caps ? text.toUpperCase() : text; };
    const centered = CONFIG.centerTextOnly && !lay.some(it => it.icon || it.bars !== undefined);
    const statics = lay.filter(it => it.text).map(it => {
      const L = layout(fix(it.text)), base = Math.round(it.base);
      return {L, cx: it.cx, base: centered ? base + centerShift(L, base) : base};
    });
    const longText = st.text ? fix(st.text) : null;
    const base = fb => {
      for(const it of lay){
        if(it.icon) drawIcon(fb, it.icon, it.pdx || 0);
        else if(it.bars !== undefined) for(let i = 0; i < 3; i++) drawIcon(fb, i < it.bars ? "barOn" : "barOff", i*CONFIG.barStep);
      }
      for(const s of statics) drawCentered(fb, s.L, s.cx, s.base);
    };
    const id = [name, caps, textMode, JSON.stringify(swap)].join("|");
    if(!longText) return {key: id, animated: false, draw: fb => { fb.fill(0); base(fb); }};
    const whole = layout(longText), lb0 = Math.round(LONG.base), lbase = centered ? lb0 + centerShift(whole, lb0) : lb0;
    if(textMode === "step"){
      const k = Math.floor(t / CONFIG.stepMs) % 2, half = layout(splitText(longText)[k]);
      return {key: id + "|" + k, animated: true, draw: fb => { fb.fill(0); base(fb); drawCentered(fb, half, LONG.cx, lbase); }};
    }
    const span = Math.round(CONFIG.padL + whole.width + CONFIG.padR), off = Math.floor(t * CONFIG.scrollPx / 1000) % span;
    const pad = Math.round(CONFIG.padL);
    return {key: id + "|" + off, animated: true, draw: fb => { fb.fill(0); base(fb); for(const s of [0, span]) drawString(fb, whole, pad + s - off, lbase); }};
  }

  window.HMI = {W, H, CONFIG, LAYOUTS, screens: SCREENS.map(s => s.name), frame,
    ready: () => !!font()};
})();
