/**
 * RÉSUMÉ BUILDER — content/resume.json → app/public/resume.pdf.
 *
 * Runs at BUILD time (last step of `npm run build`, after vite has emptied
 * and refilled the outDir), so the PDF ships as a static asset: the pipeline
 * publishes it to S3 and bakes it into the container image, which means the
 * résumé downloads even while the API sleeps. No Lambda, no cold start, no
 * client-side PDF hacks — the "backend" that generates it is the pipeline.
 *
 * It wears the site's own finish — Surf Green, the pick, Archivo and
 * JetBrains Mono — because a résumé that looks like every other résumé says
 * nothing about who wrote it. The finish is paint, though; the STRUCTURE is
 * still what applicant-tracking systems parse best, and those rules are
 * constraints, not style preferences:
 *   - one column, top-to-bottom reading order — no tables, no text boxes;
 *   - real text only: the faces are embedded as subsets with their Unicode
 *     maps, so every word extracts exactly as written (check it with any
 *     PDF-to-text tool after touching this file);
 *   - conventional ALL-CAPS section headings (SUMMARY / PROFESSIONAL
 *     EXPERIENCE / EDUCATION / SKILLS) that ATS section-classifiers key on;
 *   - each role as "Title, Company | Dates | Location" on plain text lines;
 *   - plain "•" bullets as text; colour never carries meaning;
 *   - the only drawings are vector paint (the band and the pick): no
 *     images, no repeated headers or footers with text in them;
 *   - document metadata (Title/Author/Keywords) filled in.
 *
 * Name and contact come from content.json's profile so the PDF can never
 * drift from the site chrome.
 */
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const profile = JSON.parse(readFileSync(resolve(root, 'content/content.json'), 'utf8')).profile;
const resume = JSON.parse(readFileSync(resolve(root, 'content/resume.json'), 'utf8'));
const outPath = resolve(root, 'app/public/resume.pdf');

/* ---- the finish: Surf Green over graphite, the colours of themes/surf-orbit.json and seafoam-studio.json ---- */
const INK = '#1D2325';
const MUTED = '#5B6664';
const ACCENT = '#146B5D';
const SURF = '#7FC8B9';
const RULE = '#C7D2CF';

/* ---- the faces: static cuts of the site's own families (the variable files cannot be instanced into a PDF) ---- */
const face = (pkg, file) => readFileSync(resolve(here, '../node_modules/@fontsource', pkg, 'files', file));
const FACES = {
  Display: face('archivo-black', 'archivo-black-latin-400-normal.woff'),
  Body: face('archivo', 'archivo-latin-400-normal.woff'),
  Semi: face('archivo', 'archivo-latin-600-normal.woff'),
  Bold: face('archivo', 'archivo-latin-700-normal.woff'),
  Heavy: face('archivo', 'archivo-latin-800-normal.woff'),
  Mono: face('jetbrains-mono', 'jetbrains-mono-latin-400-normal.woff'),
};

/* ---- page geometry (US Letter, 0.75in margins) ---- */
const MARGIN = 54;
const BODY = 9.7;
const LEAD = 1.7;
const doc = new PDFDocument({
  size: 'LETTER',
  margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
  info: {
    Title: `${profile.name} — Résumé`,
    Author: profile.name,
    Subject: resume.role ?? profile.role,
    Keywords: resume.skills.map((s) => s.items).join(', '),
  },
});
for (const [name, src] of Object.entries(FACES)) doc.registerFont(name, src);
const W = doc.page.width - MARGIN * 2;
const BOTTOM = () => doc.page.height - MARGIN;

mkdirSync(dirname(outPath), { recursive: true });
doc.pipe(createWriteStream(outPath));

/** The band along the top edge of every page: paint only, it never touches the text flow. */
function band() {
  doc.save().rect(0, 0, doc.page.width, 7).fill(SURF).restore();
}
let pages = 1;
band();
doc.on('pageAdded', () => {
  pages += 1;
  band();
});

/** The pick, top right of the first page: a guitar pick in Surf Green, drawn as one path. */
function pick(x, y, height) {
  const s = height / 118;
  doc
    .save()
    .translate(x, y)
    .scale(s)
    .path('M50 116 C38 100 7 72 6 40 C5 16 24 4 50 4 C76 4 95 16 94 40 C93 72 62 100 50 116 Z')
    .lineWidth(5)
    .fillAndStroke(SURF, ACCENT)
    .restore();
}

/** Start a new page unless `need` points of vertical room remain. */
function ensure(need) {
  if (doc.y + need > BOTTOM()) doc.addPage();
}

function heading(text) {
  ensure(40);
  doc.moveDown(0.85);
  doc.font('Heavy').fontSize(9.6).fillColor(ACCENT).text(text.toUpperCase(), MARGIN, doc.y, { width: W, characterSpacing: 1.1 });
  const y = doc.y + 2;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + W, y).lineWidth(0.75).strokeColor(RULE).stroke();
  doc.fillColor(INK).moveDown(0.5);
}

/** "**bold**" marks the claim to catch when skimming; the markers never reach the page. */
const runs = (text) =>
  text.split('**').map((t, i) => ({ text: t, bold: i % 2 === 1 })).filter((r) => r.text);
const plain = (text) => text.replaceAll('**', '');

/** "•" with a hanging indent, page-break safe, bold runs kept inline. */
function bullet(text) {
  const gap = 12;
  const parts = runs(text);
  doc.font('Body').fontSize(BODY);
  ensure(doc.heightOfString(plain(text), { width: W - gap, lineGap: LEAD }) + 2);
  const y = doc.y;
  doc.fillColor(ACCENT).text('•', MARGIN, y).fillColor(INK);
  parts.forEach((run, i) => {
    doc.font(run.bold ? 'Bold' : 'Body');
    const opts = { width: W - gap, lineGap: LEAD, continued: i < parts.length - 1 };
    if (i === 0) doc.text(run.text, MARGIN + gap, y, opts);
    else doc.text(run.text, opts);
  });
  doc.moveDown(0.22);
}

/** Highlight bullet: marked runs print bold; with none marked, the thesis up to the first ": " does. */
function highlight(text) {
  if (!text.includes('**')) {
    const i = text.indexOf(': ');
    if (i >= 0) text = `**${text.slice(0, i + 2)}**${text.slice(i + 2)}`;
  }
  bullet(text);
}

/* ---- header: the pick, then name, role and two contact lines ---- */
pick(MARGIN + W - 30, MARGIN - 4, 36);
doc.font('Display').fontSize(23).fillColor(INK).text(profile.name, MARGIN, MARGIN - 3, { width: W - 44 });
doc.moveDown(0.1);
doc.font('Semi').fontSize(11.5).fillColor(ACCENT).text(resume.role ?? profile.role, { width: W - 44 });
doc.moveDown(0.4);
const linkedIn = (profile.links ?? []).find((l) => l.label === 'LinkedIn')?.url ?? '';
const gitHub = (profile.links ?? []).find((l) => l.label === 'GitHub')?.url ?? '';
/* two deliberate lines, who-and-where then the profiles: one long line wraps mid-location */
const strip = (url) => url.replace(/^https?:\/\/(www\.)?/, '');
const contactLines = [
  [profile.contact, strip(resume.website), resume.location],
  [strip(linkedIn), strip(gitHub)],
].map((parts) => parts.filter(Boolean).join('  |  '));
doc.font('Mono').fontSize(8.1).fillColor(MUTED).text(contactLines.join('\n'), { width: W, lineGap: 2.2 });
doc.fillColor(INK);

/* ---- summary ---- */
heading('Summary');
doc.font('Body').fontSize(BODY).text(resume.summary, { width: W, lineGap: LEAD });

/* ---- selected accomplishments (above the fold, before the first role) ---- */
if (Array.isArray(resume.highlights) && resume.highlights.length) {
  heading('Career Highlights');
  for (const h of resume.highlights) highlight(h);
}

/* ---- experience: current roles in full, older ones under their own heading ---- */
/** Approximate height of a whole role block, so a keepTogether role moves to the next page intact. */
function roleHeight(job) {
  doc.font('Body').fontSize(BODY);
  const body = job.bullets.reduce(
    (h, b) => h + doc.heightOfString(plain(b), { width: W - 12, lineGap: LEAD }) + doc.currentLineHeight(true) * 0.22,
    0,
  );
  return 40 + body;
}
/** The role's title line, plus its dates line unless this is a continuation at the top of a new page. */
function roleHeader(job, continued = false) {
  const title = `${job.title}, ${job.company}${continued ? ' (continued)' : ''}`;
  doc.font('Bold').fontSize(10.4).fillColor(INK).text(title, MARGIN, doc.y, { width: W });
  if (!continued) {
    const meta = [`${job.start} – ${job.end}`, job.type, job.location].filter(Boolean).join('  |  ');
    doc.moveDown(0.1);
    doc.font('Mono').fontSize(7.9).fillColor(MUTED).text(meta, { width: W });
  }
  doc.fillColor(INK).moveDown(0.3);
}
/** Height one bullet will take, so a role that may split breaks between bullets, never inside one. */
function bulletHeight(text) {
  doc.font('Body').fontSize(BODY);
  return doc.heightOfString(plain(text), { width: W - 12, lineGap: LEAD }) + 2;
}
function roles(jobs) {
  jobs.forEach((job, i) => {
    if (i > 0) doc.moveDown(0.5);
    ensure(job.keepTogether ? roleHeight(job) : 48);
    roleHeader(job);
    for (const b of job.bullets) {
      /* a role allowed to split carries its name onto the next page, so no bullet is orphaned */
      if (!job.keepTogether && doc.y + bulletHeight(b) > BOTTOM()) {
        doc.addPage();
        roleHeader(job, true);
      }
      bullet(b);
    }
  });
}

heading('Professional Experience');
roles(resume.experience.filter((job) => !job.earlier));
const earlier = resume.experience.filter((job) => job.earlier);
if (earlier.length) {
  heading('Earlier Experience');
  roles(earlier);
}

/* ---- education (the degree in both languages, per the record) ---- */
heading('Education');
for (const ed of resume.education) {
  doc.font('Bold').fontSize(10.2).text(ed.degree, MARGIN, doc.y, { width: W });
  doc.font('Body').fontSize(BODY).text(`${ed.degreeNative} — ${ed.school}, ${ed.location}`, { width: W, lineGap: LEAD });
  if (ed.detail) doc.fontSize(9.3).fillColor(MUTED).text(ed.detail, { width: W, lineGap: LEAD });
  doc.fillColor(INK);
}

/* ---- skills ---- */
heading('Skills');
for (const s of resume.skills) {
  const line = `${s.group}: `;
  doc.font('Bold').fontSize(9.4);
  ensure(doc.heightOfString(line + s.items, { width: W, lineGap: LEAD }) + 2);
  doc.text(line, MARGIN, doc.y, { width: W, continued: true });
  doc.font('Body').text(s.items, { width: W, lineGap: LEAD });
  doc.moveDown(0.12);
}

/* ---- languages ---- */
heading('Languages');
doc.font('Body').fontSize(BODY).text(resume.languages, MARGIN, doc.y, { width: W, lineGap: LEAD });

/* ---- outside work: the person behind the pages, and where this file came from ---- */
if (resume.outside) {
  heading('Outside Work');
  doc.font('Body').fontSize(BODY).text(resume.outside, MARGIN, doc.y, { width: W, lineGap: LEAD });
  /* in the pipeline the PDF says which commit built it; a local build has no stamp to give */
  const sha = (process.env.GIT_SHA || process.env.CODEBUILD_RESOLVED_SOURCE_VERSION || '').slice(0, 7);
  if (/^[0-9a-f]{7}$/.test(sha)) {
    doc.moveDown(0.35);
    doc.font('Mono').fontSize(7.2).fillColor(MUTED).text(`build ${sha}`, { width: W });
  }
}

doc.end();
console.log(`resume.pdf written to ${outPath} (${pages} page${pages === 1 ? '' : 's'})`);
if (pages !== 2) console.warn(`WARNING: the résumé's page budget is two pages and this build has ${pages}.`);
