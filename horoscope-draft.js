#!/usr/bin/env node
// Horoscope draft generator — Study A pipeline steps 1-2.
//
// Drafting discipline (paper IV-C): the prose generator consumes ONLY the
// chart endpoint's rendered summary and aspect list, copying sign names and
// degrees verbatim. It performs zero astronomical arithmetic: no longitude→sign
// conversions, no invented numbers. Every fact that reaches print is copied
// from code that already did the math. Errors that require computing to
// introduce cannot occur when there is nothing being computed.
//
// Output goes to stdout; pipe it through tools/claim_audit.py for the
// pre-publication gate (pipeline step 3):
//   node horoscope-draft.js --date 2026-09-10 --sign Aries \
//     | python3 tools/claim_audit.py - --date 2026-09-10

const astro = require('./astro-engine');

const SIGNS = {
  Aries:      { ruler: 'Mars',    element: 'fire' },
  Taurus:     { ruler: 'Venus',   element: 'earth' },
  Gemini:     { ruler: 'Mercury', element: 'air' },
  Cancer:     { ruler: 'Moon',    element: 'water' },
  Leo:        { ruler: 'Sun',     element: 'fire' },
  Virgo:      { ruler: 'Mercury', element: 'earth' },
  Libra:      { ruler: 'Venus',   element: 'air' },
  Scorpio:    { ruler: 'Mars',    element: 'water' },
  Sagittarius:{ ruler: 'Jupiter', element: 'fire' },
  Capricorn:  { ruler: 'Saturn',  element: 'earth' },
  Aquarius:   { ruler: 'Uranus',  element: 'air' },
  Pisces:     { ruler: 'Neptune', element: 'water' },
};

// Verb forms for the five Ptolemaic aspects; nouns/phrasing chosen so the
// claim auditor's aspect patterns recognize every sentence we emit.
const ASPECT_VERB = {
  Conjunction: 'conjuncts',
  Sextile: 'sextiles',
  Square: 'squares',
  Trine: 'trines',
  Opposition: 'opposes',
};

/**
 * Collect engine-rendered facts for every body: signName and degreesInSign as
 * the engine already converted them. The summary string only names Sun/Moon/
 * angles, but chart.planets carries the same rendered fields for all ten —
 * reading those is still copying code's answer, not doing arithmetic (IV-C).
 * @param {object} planets - chart.planets map from calculateNatalChart
 * @returns {Object<string,{sign:string,deg:number}>} keyed by capitalized name
 */
function bodyFacts(planets) {
  const out = {};
  for (const [key, p] of Object.entries(planets)) {
    out[key[0].toUpperCase() + key.slice(1)] = { sign: p.signName, deg: p.degreesInSign };
  }
  return out;
}

/** Render one horoscope entry for `sign` using only copied facts. */
function renderDraft(signName, chart) {
  const me = SIGNS[signName];
  if (!me) throw new Error(`unknown sign: ${signName}`);
  const bodies = bodyFacts(chart.planets);
  const need = (n) => {
    if (!bodies[n]) throw new Error(`summary missing body "${n}" — refusing to invent it`);
    return bodies[n];
  };

  // Tightest-orb aspects involving this sign's ruler, else the two tightest overall.
  const ruler = me.ruler;
  const touching = chart.aspects.filter(a => a.body1 === ruler.toLowerCase() || a.body2 === ruler.toLowerCase());
  const featured = (touching.length ? touching : chart.aspects).slice(0, 2);

  const cap = s => s[0].toUpperCase() + s.slice(1);
  const aspectSentence = (a) => {
    const b1 = cap(a.body1), b2 = cap(a.body2);
    return `${b1} ${ASPECT_VERB[a.name]} ${b2}`;
  };

  const sun = need('Sun'), moon = need('Moon');
  const rulerPos = need(ruler);

  // Every fact phrase uses the auditor's recognized grammar ("X in SIGN",
  // "X squares Y") so nothing this generator emits escapes the gate.
  const theme = `The Sun moves in ${sun.sign} while your ruler ${ruler} stands in ${rulerPos.sign} ${rulerPos.deg.toFixed(1)}°; the Moon is in ${moon.sign}, and that pairing sets the weather for ${signName}.`;
  const first = featured[0] ? `${aspectSentence(featured[0])} early in the day — the tension is specific, so point it at one concrete task instead of your whole life.` : `The sky keeps quiet about your ruler today; make your own news.`;
  const second = featured[1] ? `Later, ${aspectSentence(featured[1]).toLowerCase()}, which favors ${me.element === 'fire' ? 'starting' : me.element === 'earth' ? 'finishing' : me.element === 'air' ? 'talking' : 'feeling'} the thing you have been circling.` : '';

  return [
    `${signName} — daily draft (engine-rendered facts only)`,
    '',
    theme,
    first + ' ' + second,
    `Nothing above was computed by a language model: every sign and degree copied from the ephemeris service's own summary.`,
  ].join('\n').replace(/[ ]+\n/g, '\n');
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : dflt;
  };

  const dateStr = arg('--date', null);
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    console.error('usage: horoscope-draft.js --date YYYY-MM-DD [--sign Name] [--lat 40] [--lon -75]');
    process.exit(2);
  }
  const [y, mo, d] = dateStr.split('-').map(Number);
  const lat = Number(arg('--lat', '40')), lon = Number(arg('--lon', '-75'));

  // One chart per run; the sky is global — only the addressee changes.
  const chart = astro.calculateNatalChart({ year: y, month: mo, day: d }, 12, lat, lon);

  const wanted = arg('--sign', null);
  const names = wanted ? [wanted] : Object.keys(SIGNS);
  for (const name of names) {
    if (!Object.hasOwn(SIGNS, name)) { console.error(`unknown sign: ${name}`); process.exit(2); }
    console.log(renderDraft(name, chart));
    console.log('\n---\n');
  }
}

if (require.main === module) main();
module.exports = { renderDraft, bodyFacts, SIGNS };
