#!/usr/bin/env node
// AuroraPro typeface study — mockup generator.
//
// Emits three standalone SVG wordmark mockups plus specimen.html (the
// comparison page) into this directory. The letterforms are hand-drawn
// vector paths — no existing font is used or traced.
//
//   node docs/design/aurorapro-typeface/generate.mjs
//
// Shared glyph skeleton (centerline coordinates, y grows downward):
//   cap top y=30 · x-height y=110 · baseline y=220
// Letters in "AuroraPro": A u r o r a P r o. Each concept restyles the
// same skeleton the way real font cuts share metrics but not details.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Concept 01 — BOREALIS. Rounded geometric monoline, round terminals,
// aurora-wave crossbar on A, rising "light-trail" flicks on the r arms.
// Stroke 26. Gradient ink, violet → cyan, left to right (banner gradient).
// ---------------------------------------------------------------------------
const borealisPaths = [
  // A — apex + wave crossbar (the aurora ribbon lives inside the letter)
  'M 40 220 L 115 30 L 190 220',
  'M 69 151 C 99 139 131 163 161 151',
  // u — bowl touches baseline, right stem runs through to baseline
  'M 234 110 V 172 A 48 48 0 0 0 330 172',
  'M 330 110 V 220',
  // r — stem + shoulder that lifts at the tip
  'M 388 110 V 220',
  'M 388 168 A 58 58 0 0 1 446 110 Q 452 110 458 104',
  // o
  'M 480 165 A 55 55 0 1 1 590 165 A 55 55 0 1 1 480 165',
  // r
  'M 648 110 V 220',
  'M 648 168 A 58 58 0 0 1 706 110 Q 712 110 718 104',
  // a — single-storey: round bowl + full stem
  'M 740 165 A 55 55 0 1 1 850 165 A 55 55 0 1 1 740 165',
  'M 850 110 V 220',
  // P — full-height stem, half-depth bowl
  'M 912 30 V 220',
  'M 912 30 H 964 A 47 47 0 0 1 964 124 H 912',
  // r
  'M 1048 110 V 220',
  'M 1048 168 A 58 58 0 0 1 1106 110 Q 1112 110 1118 104',
  // o
  'M 1140 165 A 55 55 0 1 1 1250 165 A 55 55 0 1 1 1140 165',
];

// ---------------------------------------------------------------------------
// Concept 02 — MERIDIAN. Chamfered octagonal construction, butt terminals,
// flat-top A. Stroke 24. Everything a curve elsewhere is a 45° cut here.
// Two-tone lockup: "Aurora" cool white, "Pro" cyan (today's split, kept).
// ---------------------------------------------------------------------------
const meridianAurora = [
  // A — flat-top apex like a survey marker
  'M 40 220 L 96 30 H 134 L 190 220',
  'M 60 152 H 170',
  // u — chamfered bucket
  'M 234 110 V 184 L 270 220 H 294 L 330 184',
  'M 330 110 V 220',
  // r — angular arm
  'M 388 110 V 220',
  'M 388 138 L 416 110 H 452',
  // o — the play-mark aperture, milled octagonal
  'M 514 110 H 556 L 590 144 V 186 L 556 220 H 514 L 480 186 V 144 Z',
  // r
  'M 648 110 V 220',
  'M 648 138 L 676 110 H 712',
  // a — octagonal bowl + stem
  'M 774 110 H 816 L 850 144 V 186 L 816 220 H 774 L 740 186 V 144 Z',
  'M 850 110 V 220',
];
const meridianPro = [
  // P — chamfered bowl
  'M 912 30 V 220',
  'M 912 30 H 978 L 1010 62 V 92 L 978 124 H 912',
  // r
  'M 1048 110 V 220',
  'M 1048 138 L 1076 110 H 1112',
  // o
  'M 1174 110 H 1216 L 1250 144 V 186 L 1216 220 H 1174 L 1140 186 V 144 Z',
];

// ---------------------------------------------------------------------------
// Concept 03 — PHOTON. Heavyweight rounded display, stroke 36, sliced by two
// full-width light bands (stencil cuts); an unmasked blurred copy glows
// through the gaps. Vertical gradient runs green → cyan → violet, the actual
// color order of an auroral curtain, shifted onto the brand ramp.
// ---------------------------------------------------------------------------
const photonPaths = [
  'M 40 220 L 115 30 L 190 220',
  'M 76 134 H 154',
  'M 234 110 V 172 A 48 48 0 0 0 330 172',
  'M 330 110 V 220',
  'M 388 110 V 220',
  'M 388 168 A 58 58 0 0 1 446 110',
  'M 480 165 A 55 55 0 1 1 590 165 A 55 55 0 1 1 480 165',
  'M 648 110 V 220',
  'M 648 168 A 58 58 0 0 1 706 110',
  'M 740 165 A 55 55 0 1 1 850 165 A 55 55 0 1 1 740 165',
  'M 850 110 V 220',
  'M 912 30 V 220',
  'M 912 30 H 964 A 47 47 0 0 1 964 124 H 912',
  'M 1048 110 V 220',
  'M 1048 168 A 58 58 0 0 1 1106 110',
  'M 1140 165 A 55 55 0 1 1 1250 165 A 55 55 0 1 1 1140 165',
];
// Light bands (letter coordinates): a wide cut and a narrow echo below it.
const PHOTON_BANDS = [ { y: 156, h: 12 }, { y: 184, h: 8 } ];

const pathEls = (paths, extra = '') =>
  paths.map((d) => `    <path d="${d}"${extra}/>`).join('\n');

// --- shared standalone-file furniture --------------------------------------

const MONO =
  "ui-monospace, 'SF Mono', 'Cascadia Code', 'JetBrains Mono', Menlo, Consolas, monospace";

const stars = (pts) =>
  pts
    .map(([x, y, r, o]) => `    <circle cx="${x}" cy="${y}" r="${r}" fill="#FFFFFF" opacity="${o}"/>`)
    .join('\n');

const caption = (left, right) => `  <text x="40" y="309" font-family="${MONO}" font-size="15" letter-spacing="1" fill="#9BA3C7">${left}</text>
  <text x="1250" y="309" text-anchor="end" font-family="${MONO}" font-size="13" letter-spacing="1" fill="#5A6490">${right}</text>`;

// --- concept 01 standalone svg ---------------------------------------------

const borealisSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1290 330" width="1290" height="330" role="img"
     aria-label="AuroraPro wordmark — concept 1, Borealis: rounded monoline with wave crossbar and gradient ink">
  <!-- Concept 01 · BOREALIS — hand-drawn letterforms, generated by generate.mjs -->
  <defs>
    <!-- userSpaceOnUse: an objectBoundingBox gradient is undefined on the
         zero-width bbox of a vertical stem and Chromium drops the stroke. -->
    <linearGradient id="bInk" gradientUnits="userSpaceOnUse" x1="27" y1="0" x2="1263" y2="0">
      <stop offset="0" stop-color="#C4B5FD"/>
      <stop offset="0.42" stop-color="#A855F7"/>
      <stop offset="0.72" stop-color="#7C3AED"/>
      <stop offset="1" stop-color="#22D3EE"/>
    </linearGradient>
    <linearGradient id="bRibbon" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#22D3EE" stop-opacity="0"/>
      <stop offset="0.4" stop-color="#22D3EE" stop-opacity="0.5"/>
      <stop offset="0.75" stop-color="#A855F7" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#A855F7" stop-opacity="0"/>
    </linearGradient>
    <filter id="bSoft" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="20"/>
    </filter>
  </defs>
  <rect width="1290" height="330" fill="#0A0E1E"/>
  <path d="M -40 118 C 240 48 520 156 800 92 C 1010 44 1190 96 1330 60 L 1330 -30 L -40 -30 Z"
        fill="url(#bRibbon)" filter="url(#bSoft)" opacity="0.5"/>
${stars([[120, 60, 1.5, 0.7], [372, 40, 1.1, 0.5], [700, 52, 1.4, 0.65], [968, 38, 1.1, 0.5], [1176, 64, 1.5, 0.7], [560, 286, 1.0, 0.35], [1080, 292, 1.0, 0.35]])}
  <g transform="translate(0,28)" fill="none" stroke="url(#bInk)" stroke-width="26"
     stroke-linecap="round" stroke-linejoin="round">
${pathEls(borealisPaths)}
  </g>
${caption('01 · BOREALIS &#8212; rounded monoline &#183; aurora-wave crossbar &#183; gradient ink', 'AuroraPro typeface study')}
</svg>
`;

// --- concept 02 standalone svg ---------------------------------------------

const METRICS = [
  ['CAP', 58], ['X-HT', 138], ['BASE', 248],
];

const meridianSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1290 330" width="1290" height="330" role="img"
     aria-label="AuroraPro wordmark — concept 2, Meridian: chamfered octagonal construction, flat-top A, two-tone">
  <!-- Concept 02 · MERIDIAN — hand-drawn letterforms, generated by generate.mjs -->
  <defs>
    <pattern id="mGrid" width="43" height="43" patternUnits="userSpaceOnUse">
      <path d="M 43 0 H 0 V 43" fill="none" stroke="#7DD3FC" stroke-opacity="0.05" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="1290" height="330" fill="#0B101F"/>
  <rect width="1290" height="330" fill="url(#mGrid)"/>
  <g stroke="#7DD3FC" stroke-opacity="0.14" stroke-width="1" stroke-dasharray="2 6">
${METRICS.map(([, y]) => `    <line x1="24" y1="${y}" x2="1266" y2="${y}"/>`).join('\n')}
  </g>
  <g transform="translate(0,28)" fill="none" stroke-width="24"
     stroke-linecap="butt" stroke-linejoin="miter">
    <g stroke="#E8EDFB">
${pathEls(meridianAurora).replace(/^ {4}/gm, '      ')}
    </g>
    <g stroke="#22D3EE">
${pathEls(meridianPro).replace(/^ {4}/gm, '      ')}
    </g>
  </g>
${caption('02 · MERIDIAN &#8212; chamfered construction &#183; flat-top apex &#183; terminal grade', 'AuroraPro typeface study')}
</svg>
`;

// --- concept 03 standalone svg ---------------------------------------------

const photonSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1290 330" width="1290" height="330" role="img"
     aria-label="AuroraPro wordmark — concept 3, Photon: heavyweight display sliced by two light bands, with glow">
  <!-- Concept 03 · PHOTON — hand-drawn letterforms, generated by generate.mjs -->
  <defs>
    <linearGradient id="pInk" gradientUnits="userSpaceOnUse" x1="0" y1="12" x2="0" y2="238">
      <stop offset="0" stop-color="#6EE7B7"/>
      <stop offset="0.45" stop-color="#22D3EE"/>
      <stop offset="1" stop-color="#A855F7"/>
    </linearGradient>
    <radialGradient id="pHalo" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#22D3EE" stop-opacity="0.14"/>
      <stop offset="1" stop-color="#22D3EE" stop-opacity="0"/>
    </radialGradient>
    <filter id="pGlow" x="-20%" y="-40%" width="140%" height="180%">
      <feGaussianBlur stdDeviation="10"/>
    </filter>
    <mask id="pBands" maskUnits="userSpaceOnUse" x="0" y="-30" width="1290" height="330">
      <rect x="0" y="-30" width="1290" height="330" fill="#FFFFFF"/>
${PHOTON_BANDS.map(({ y, h }) => `      <rect x="0" y="${y}" width="1290" height="${h}" fill="#000000"/>`).join('\n')}
    </mask>
  </defs>
  <rect width="1290" height="330" fill="#070B18"/>
  <ellipse cx="645" cy="165" rx="600" ry="160" fill="url(#pHalo)"/>
${stars([[96, 52, 1.6, 0.8], [298, 36, 1.2, 0.55], [536, 58, 1.4, 0.7], [820, 34, 1.1, 0.5], [1052, 56, 1.5, 0.75], [1216, 96, 1.1, 0.5], [240, 296, 1.0, 0.35], [996, 300, 1.0, 0.35]])}
  <g transform="translate(0,28)" fill="none" stroke="url(#pInk)" stroke-width="36"
     stroke-linecap="round" stroke-linejoin="round">
    <g filter="url(#pGlow)" opacity="0.55">
${pathEls(photonPaths).replace(/^ {4}/gm, '      ')}
    </g>
    <g mask="url(#pBands)">
${pathEls(photonPaths).replace(/^ {4}/gm, '      ')}
    </g>
  </g>
${caption('03 · PHOTON &#8212; heavyweight display &#183; light-band stencil &#183; title-card glow', 'AuroraPro typeface study')}
</svg>
`;

writeFileSync(join(OUT, 'concept-01-borealis.svg'), borealisSvg);
writeFileSync(join(OUT, 'concept-02-meridian.svg'), meridianSvg);
writeFileSync(join(OUT, 'concept-03-photon.svg'), photonSvg);

// ---------------------------------------------------------------------------
// specimen.html — the pitch page. Letterforms defined once (hidden defs),
// instantiated at several sizes via <use>. Deliberately single-theme: the
// aurora exists on a night sky, so the page commits to the brand's dark
// ground rather than inverting for light mode.
// ---------------------------------------------------------------------------

const bandRects = PHOTON_BANDS
  .map(({ y, h }) => `        <rect x="0" y="${y}" width="1290" height="${h}" fill="#000"/>`)
  .join('\n');

const specimen = `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>AuroraPro — Typeface Study Nº 001</title>
<style>
  :root {
    --sky-0: #070B18;
    --sky-1: #0A0E1E;
    --panel: #0D1226;
    --line: rgba(155, 163, 199, 0.16);
    --ink: #E7EAF6;
    --dim: #9BA3C7;
    --faint: #5A6490;
    --violet: #A855F7;
    --cyan: #22D3EE;
    --mono: ui-monospace, 'SF Mono', 'Cascadia Code', 'JetBrains Mono', Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  }
  html { background: var(--sky-0); color-scheme: dark; }
  body {
    margin: 0;
    background:
      radial-gradient(900px 420px at 82% -140px, rgba(168, 85, 247, 0.14), transparent 70%),
      radial-gradient(760px 380px at 12% -120px, rgba(34, 211, 238, 0.10), transparent 70%),
      var(--sky-0);
    color: var(--ink);
    font: 16px/1.65 var(--sans);
  }
  .wrap { max-width: 1120px; margin: 0 auto; padding: 64px 28px 96px; }

  .eyebrow {
    font-family: var(--mono); font-size: 12px; letter-spacing: 0.22em;
    color: var(--cyan); text-transform: uppercase; margin: 0 0 18px;
  }
  h1 {
    font-size: clamp(30px, 4.6vw, 46px); line-height: 1.12; font-weight: 750;
    letter-spacing: -0.015em; margin: 0 0 20px; max-width: 21ch; text-wrap: balance;
  }
  .brief { max-width: 62ch; color: var(--dim); margin: 0 0 28px; }
  .brief strong { color: var(--ink); font-weight: 600; }

  .tokens {
    display: flex; flex-wrap: wrap; gap: 10px 22px; align-items: center;
    font-family: var(--mono); font-size: 12.5px; color: var(--faint);
    border-block: 1px solid var(--line); padding: 14px 2px; margin-bottom: 84px;
  }
  .tok { display: inline-flex; align-items: center; gap: 8px; }
  .sw { width: 14px; height: 14px; border-radius: 4px; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14); }

  .plate { margin-bottom: 96px; }
  .plate-head { display: flex; align-items: baseline; gap: 18px; margin-bottom: 6px; }
  .idx {
    font-family: var(--mono); font-size: 13px; letter-spacing: 0.18em;
    color: var(--faint); border: 1px solid var(--line); border-radius: 999px;
    padding: 4px 12px; white-space: nowrap;
  }
  .plate h2 { font-size: clamp(22px, 3vw, 30px); font-weight: 700; letter-spacing: -0.01em; margin: 0; }
  .plate h2 small { font-weight: 500; color: var(--faint); font-size: 0.62em; margin-left: 10px; letter-spacing: 0; }
  .thesis { color: var(--dim); font-size: 17px; margin: 6px 0 22px; max-width: 58ch; }

  .stage {
    border: 1px solid var(--line); border-radius: 16px; padding: clamp(18px, 4vw, 44px) clamp(12px, 3vw, 36px);
    overflow: hidden;
  }
  .stage svg { display: block; width: 100%; height: auto; }
  .stage-b {
    background:
      radial-gradient(70% 130% at 50% -30%, rgba(168, 85, 247, 0.16), transparent 60%),
      radial-gradient(60% 110% at 92% 110%, rgba(34, 211, 238, 0.10), transparent 65%),
      var(--sky-1);
  }
  .stage-m {
    background:
      repeating-linear-gradient(0deg, rgba(125, 211, 252, 0.045) 0 1px, transparent 1px 43px),
      repeating-linear-gradient(90deg, rgba(125, 211, 252, 0.045) 0 1px, transparent 1px 43px),
      #0B101F;
  }
  .stage-p {
    background:
      radial-gradient(55% 90% at 50% 50%, rgba(34, 211, 238, 0.11), transparent 70%),
      radial-gradient(40% 70% at 78% 20%, rgba(168, 85, 247, 0.12), transparent 70%),
      #070B18;
  }

  .specs {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 1px; background: var(--line); border: 1px solid var(--line);
    border-radius: 12px; overflow: hidden; margin-top: 18px;
  }
  .spec { background: var(--panel); padding: 14px 16px; }
  .spec dt {
    font-family: var(--mono); font-size: 11px; letter-spacing: 0.16em;
    text-transform: uppercase; color: var(--faint); margin: 0 0 6px;
  }
  .spec dd { margin: 0; font-size: 14.5px; color: var(--dim); }
  .spec dd b { color: var(--ink); font-weight: 600; }

  .scale { margin-top: 26px; }
  .scale-row { display: flex; align-items: flex-end; gap: 34px; flex-wrap: wrap; }
  .scale-row svg { display: block; height: auto; }
  .scale-note {
    font-family: var(--mono); font-size: 12.5px; color: var(--faint);
    margin-top: 12px; max-width: 74ch;
  }
  .scale-note b { color: var(--dim); font-weight: 600; }

  .verdict { border-top: 1px solid var(--line); padding-top: 56px; }
  .verdict h2 { font-size: clamp(24px, 3.2vw, 32px); letter-spacing: -0.01em; margin: 0 0 18px; }
  .tbl-scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; }
  table { border-collapse: collapse; width: 100%; min-width: 640px; font-size: 14.5px; }
  th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  thead th {
    font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--faint); background: var(--panel); font-weight: 500;
  }
  td:first-child {
    font-family: var(--mono); font-size: 12px; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--faint); white-space: nowrap;
  }
  td { color: var(--dim); }
  td b { color: var(--ink); font-weight: 600; }

  .reco {
    border: 1px solid rgba(168, 85, 247, 0.4); background: rgba(168, 85, 247, 0.07);
    border-radius: 14px; padding: 22px 24px; margin-top: 30px; max-width: 74ch;
  }
  .reco p { margin: 0 0 10px; color: var(--dim); }
  .reco p:last-child { margin-bottom: 0; }
  .reco b { color: var(--ink); }
  .next { margin-top: 40px; max-width: 70ch; }
  .next h3 { font-size: 18px; margin: 0 0 10px; }
  .next ol { margin: 0; padding-left: 22px; color: var(--dim); }
  .next li { margin-bottom: 8px; }
  .next li::marker { font-family: var(--mono); color: var(--faint); }
  code { font-family: var(--mono); font-size: 0.88em; color: var(--ink); background: var(--panel); padding: 1px 6px; border-radius: 5px; }
  footer {
    margin-top: 72px; border-top: 1px solid var(--line); padding-top: 20px;
    font-family: var(--mono); font-size: 12px; color: var(--faint);
  }

  .draw { stroke-dasharray: 1; stroke-dashoffset: 1; animation: draw 1.5s cubic-bezier(0.4, 0, 0.2, 1) forwards; }
  .draw-2 { animation-delay: 0.18s; }
  .draw-3 { animation-delay: 0.36s; }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .draw, .draw-2, .draw-3 { animation: none; stroke-dasharray: none; stroke-dashoffset: 0; }
  }
</style>

<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <linearGradient id="gB" x1="0" y1="0" x2="1290" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#C4B5FD"/>
      <stop offset="0.42" stop-color="#A855F7"/>
      <stop offset="0.72" stop-color="#7C3AED"/>
      <stop offset="1" stop-color="#22D3EE"/>
    </linearGradient>
    <linearGradient id="gP" x1="0" y1="12" x2="0" y2="238" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#6EE7B7"/>
      <stop offset="0.45" stop-color="#22D3EE"/>
      <stop offset="1" stop-color="#A855F7"/>
    </linearGradient>
    <filter id="fGlow" x="-20%" y="-40%" width="140%" height="180%">
      <feGaussianBlur stdDeviation="10"/>
    </filter>
    <mask id="mBands" maskUnits="userSpaceOnUse" x="0" y="-40" width="1290" height="340">
      <rect x="0" y="-40" width="1290" height="340" fill="#fff"/>
${bandRects}
    </mask>

    <g id="w-borealis" fill="none" stroke="url(#gB)" stroke-width="26"
       stroke-linecap="round" stroke-linejoin="round">
${pathEls(borealisPaths, ' pathLength="1"')}
    </g>

    <g id="w-meridian" fill="none" stroke-width="24" stroke-linecap="butt" stroke-linejoin="miter">
      <g stroke="#E8EDFB">
${pathEls(meridianAurora, ' pathLength="1"').replace(/^ {4}/gm, '        ')}
      </g>
      <g stroke="#22D3EE">
${pathEls(meridianPro, ' pathLength="1"').replace(/^ {4}/gm, '        ')}
      </g>
    </g>

    <g id="w-photon-core" fill="none" stroke="url(#gP)" stroke-width="36"
       stroke-linecap="round" stroke-linejoin="round">
${pathEls(photonPaths, ' pathLength="1"').replace(/^ {4}/gm, '      ')}
    </g>
    <g id="w-photon">
      <use href="#w-photon-core" filter="url(#fGlow)" opacity="0.55"/>
      <use href="#w-photon-core" mask="url(#mBands)"/>
    </g>
  </defs>
</svg>

<div class="wrap">
  <header>
    <p class="eyebrow">AuroraPro &middot; Typeface Study N&ordm; 001</p>
    <h1>One name, written in light, three ways.</h1>
    <p class="brief">The AuroraPro wordmark currently rents whatever UI font is loaded &mdash;
      Inter today, Space Grotesk if a user flips a setting. These are three <strong>custom
      letterform studies for a wordmark face called AuroraPro</strong>: the same nine letters
      drawn on one shared skeleton (cap 190, x-height 110), styled three different ways.
      All three keep the brand's existing fixtures &mdash; the violet&rarr;cyan ramp, the night
      sky, the play-circle mark.</p>
    <div class="tokens">
      <span class="tok"><span class="sw" style="background:#A855F7"></span>#A855F7</span>
      <span class="tok"><span class="sw" style="background:#7C3AED"></span>#7C3AED</span>
      <span class="tok"><span class="sw" style="background:#22D3EE"></span>#22D3EE</span>
      <span class="tok"><span class="sw" style="background:#0A0E1E"></span>#0A0E1E night</span>
      <span class="tok">metrics &mdash; cap 190 / x-ht 110 / stroke 24&ndash;36</span>
    </div>
  </header>

  <section class="plate">
    <div class="plate-head">
      <span class="idx">CONCEPT 01</span>
      <h2>Borealis <small>the ribbon of light</small></h2>
    </div>
    <p class="thesis">The aurora as motion &mdash; soft, continuous, friendly. A rounded
      geometric monoline where the wave lives <em>inside</em> the letters: the A&rsquo;s crossbar
      is a ribbon mid-flutter, and every r releases its arm upward like a streamer.</p>
    <div class="stage stage-b">
      <svg viewBox="0 -24 1290 292" role="img" aria-label="AuroraPro set in Borealis">
        <use href="#w-borealis" class="draw"/>
      </svg>
    </div>
    <dl class="specs">
      <div class="spec"><dt>Construction</dt><dd><b>Geometric monoline</b> &mdash; circular bowls, single-storey a</dd></div>
      <div class="spec"><dt>Terminals</dt><dd><b>Round</b>, with rising light-trail flicks on r</dd></div>
      <div class="spec"><dt>Signature move</dt><dd><b>Aurora-wave crossbar</b> on the A; gradient ink runs the word</dd></div>
      <div class="spec"><dt>Wears best on</dt><dd>App header, onboarding, README &mdash; <b>the friendly face</b></dd></div>
    </dl>
    <div class="scale">
      <div class="scale-row">
        <svg viewBox="0 -24 1290 292" width="430" aria-hidden="true"><use href="#w-borealis"/></svg>
        <svg viewBox="0 -24 1290 292" width="235" aria-hidden="true"><use href="#w-borealis"/></svg>
        <svg viewBox="0 -24 1290 292" width="128" aria-hidden="true"><use href="#w-borealis"/></svg>
      </div>
      <p class="scale-note"><b>Scale test:</b> holds to nav-bar size; the wave reads as a glint
        before it disappears. In production, flatten ink to solid violet below ~24 px.</p>
    </div>
  </section>

  <section class="plate">
    <div class="plate-head">
      <span class="idx">CONCEPT 02</span>
      <h2>Meridian <small>signage for your own infrastructure</small></h2>
    </div>
    <p class="thesis">What AuroraPro is under the paint: one Go binary, systemd, Postgres &mdash;
      yours. Every curve is milled to a 45&deg; chamfer, the apex is a flat-topped survey
      marker, and the o is the play-mark aperture cut octagonal. Keeps today&rsquo;s
      AURORA&thinsp;/&thinsp;PRO two-tone split.</p>
    <div class="stage stage-m">
      <svg viewBox="0 -24 1290 292" role="img" aria-label="AuroraPro set in Meridian">
        <use href="#w-meridian" class="draw draw-2"/>
      </svg>
    </div>
    <dl class="specs">
      <div class="spec"><dt>Construction</dt><dd><b>Octagonal</b> &mdash; 45&deg; chamfers in place of curves</dd></div>
      <div class="spec"><dt>Terminals</dt><dd><b>Butt-cut</b>, engineered; no softening anywhere</dd></div>
      <div class="spec"><dt>Signature move</dt><dd><b>Flat-top A</b> + milled o; cyan Pro against cool-white Aurora</dd></div>
      <div class="spec"><dt>Wears best on</dt><dd>CLI banners, status page, version badges &mdash; <b>the operator&rsquo;s cut</b></dd></div>
    </dl>
    <div class="scale">
      <div class="scale-row">
        <svg viewBox="0 -24 1290 292" width="430" aria-hidden="true"><use href="#w-meridian"/></svg>
        <svg viewBox="0 -24 1290 292" width="235" aria-hidden="true"><use href="#w-meridian"/></svg>
        <svg viewBox="0 -24 1290 292" width="128" aria-hidden="true"><use href="#w-meridian"/></svg>
      </div>
      <p class="scale-note"><b>Scale test:</b> the sharpest small-size performer &mdash; chamfers
        rasterize cleanly, almost pixel-font at 12 px. Least &ldquo;entertainment&rdquo; of the three, most &ldquo;tool.&rdquo;</p>
    </div>
  </section>

  <section class="plate">
    <div class="plate-head">
      <span class="idx">CONCEPT 03</span>
      <h2>Photon <small>the title card</small></h2>
    </div>
    <p class="thesis">For the ten-foot screen. A heavyweight rounded display cut by two
      full-width light bands &mdash; an auroral curtain sheared horizontal &mdash; with the glow
      leaking through the cuts. The vertical ramp runs green&rarr;cyan&rarr;violet, the actual
      color order of an aurora, shifted onto the brand.</p>
    <div class="stage stage-p">
      <svg viewBox="0 -24 1290 292" role="img" aria-label="AuroraPro set in Photon">
        <use href="#w-photon" class="draw draw-3"/>
      </svg>
    </div>
    <dl class="specs">
      <div class="spec"><dt>Construction</dt><dd><b>Heavy monoline</b> (stroke 36) with stencil cuts</dd></div>
      <div class="spec"><dt>Terminals</dt><dd><b>Round, blunt</b> &mdash; mass over detail</dd></div>
      <div class="spec"><dt>Signature move</dt><dd><b>Two light bands</b> through the whole word; under-glow leaks through</dd></div>
      <div class="spec"><dt>Wears best on</dt><dd>Splash screen, TV UI, launch poster &mdash; <b>the marquee cut</b></dd></div>
    </dl>
    <div class="scale">
      <div class="scale-row">
        <svg viewBox="0 -24 1290 292" width="430" aria-hidden="true"><use href="#w-photon"/></svg>
        <svg viewBox="0 -24 1290 292" width="235" aria-hidden="true"><use href="#w-photon"/></svg>
        <svg viewBox="0 -24 1290 292" width="128" aria-hidden="true"><use href="#w-photon"/></svg>
      </div>
      <p class="scale-note"><b>Scale test:</b> a display face by design &mdash; below ~40 px the
        bands close up. Pair it with Borealis or Meridian for everything smaller.</p>
    </div>
  </section>

  <section class="verdict">
    <h2>Side by side</h2>
    <div class="tbl-scroll">
      <table>
        <thead>
          <tr><th></th><th>01 &middot; Borealis</th><th>02 &middot; Meridian</th><th>03 &middot; Photon</th></tr>
        </thead>
        <tbody>
          <tr><td>Voice</td><td><b>Warm, fluid</b> &mdash; consumer</td><td><b>Precise, engineered</b> &mdash; operator</td><td><b>Cinematic, loud</b> &mdash; marquee</td></tr>
          <tr><td>Legibility floor</td><td>Good &mdash; ~16 px</td><td><b>Best</b> &mdash; ~12 px</td><td>Display only &mdash; ~40 px</td></tr>
          <tr><td>In-app fit</td><td><b>Header + everywhere</b></td><td>Settings, status, footer</td><td>Splash + empty states</td></tr>
          <tr><td>Marketing fit</td><td>README, site, socials</td><td>Docs, changelogs</td><td><b>Posters, launch art</b></td></tr>
          <tr><td>Risk</td><td>Closest to generic geometric sans &mdash; the wave must stay</td><td>Could read cold for a movie night</td><td>Gimmick if overused</td></tr>
        </tbody>
      </table>
    </div>
    <div class="reco">
      <p><b>Recommendation: lead with 01 &middot; Borealis.</b> It carries the aurora story in the
        letterforms themselves, keeps the existing gradient, and is the only concept that works
        everywhere the name appears today &mdash; header, README banner, PWA icons.</p>
      <p>If you want a family rather than a single face: Borealis as the wordmark,
        <b>Photon as the splash/TV display cut</b> (same skeleton, so they harmonize), and
        Meridian&rsquo;s chamfer language reserved for ops surfaces like the status page.</p>
    </div>
    <div class="next">
      <h3>From mockup to font file</h3>
      <ol>
        <li>Pick a direction (or a two-cut family) and I&rsquo;ll refine spacing and details.</li>
        <li>Extend the winner beyond these nine letters: full lower/upper case, digits, punctuation.</li>
        <li>Trace the outlines in FontForge (free, scriptable) and export <code>AuroraPro.woff2</code>.</li>
        <li>Ship via <code>@font-face</code> in <code>static/redesign/app/src/index.css</code>; swap the header
          lockup in <code>App.tsx</code> and the README banner to the new face.</li>
      </ol>
    </div>
  </section>

  <footer>
    sources: docs/design/aurorapro-typeface/ &mdash; concept-01-borealis.svg &middot;
    concept-02-meridian.svg &middot; concept-03-photon.svg &middot; generate.mjs
  </footer>
</div>
`;

writeFileSync(join(OUT, 'specimen.html'), specimen);
console.log('wrote concept-01-borealis.svg, concept-02-meridian.svg, concept-03-photon.svg, specimen.html');
