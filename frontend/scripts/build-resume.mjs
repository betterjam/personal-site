/**
 * ATS RÉSUMÉ BUILDER — content/resume.json → app/public/resume.pdf.
 *
 * Runs at BUILD time (last step of `npm run build`, after vite has emptied
 * and refilled the outDir), so the PDF ships as a static asset: the pipeline
 * publishes it to S3 and bakes it into the container image, which means the
 * résumé downloads even while the API sleeps. No Lambda, no cold start, no
 * client-side PDF hacks — the "backend" that generates it is the pipeline.
 *
 * The format is deliberately what applicant-tracking systems parse best,
 * and every choice below is a constraint, not a style preference:
 *   - one column, top-to-bottom reading order — no tables, no text boxes;
 *   - Helvetica (a PDF standard font): real extractable text, zero font
 *     embedding quirks;
 *   - conventional ALL-CAPS section headings (SUMMARY / PROFESSIONAL
 *     EXPERIENCE / EDUCATION / SKILLS) that ATS section-classifiers key on;
 *   - each role as "Title, Company | Dates | Location" on plain text lines;
 *   - plain "•" bullets, no glyphs outside WinAnsi (so no arrows);
 *   - no images, headers, footers or page decorations that shred parsing;
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

/* ---- page geometry (US Letter, 0.75in margins) ---- */
const MARGIN = 54;
const doc = new PDFDocument({
  size: 'LETTER',
  margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
  info: {
    Title: `${profile.name} — Résumé`,
    Author: profile.name,
    Subject: profile.role,
    Keywords: resume.skills.map((s) => s.items).join(', '),
  },
});
const W = doc.page.width - MARGIN * 2;
const BOTTOM = () => doc.page.height - MARGIN;

mkdirSync(dirname(outPath), { recursive: true });
doc.pipe(createWriteStream(outPath));

/** Start a new page unless `need` points of vertical room remain. */
function ensure(need) {
  if (doc.y + need > BOTTOM()) doc.addPage();
}

function heading(text) {
  ensure(40);
  doc.moveDown(0.9);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text(text.toUpperCase(), MARGIN, doc.y, { width: W, characterSpacing: 0.6 });
  const y = doc.y + 2;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + W, y).lineWidth(0.75).strokeColor('#000').stroke();
  doc.moveDown(0.45);
}

/** "**bold**" marks the claim to catch when skimming; the markers never reach the page. */
const runs = (text) =>
  text.split('**').map((t, i) => ({ text: t, bold: i % 2 === 1 })).filter((r) => r.text);
const plain = (text) => text.replaceAll('**', '');

/** "•" with a hanging indent, page-break safe, bold runs kept inline. */
function bullet(text) {
  const gap = 13;
  const parts = runs(text);
  doc.font('Helvetica').fontSize(10);
  ensure(doc.heightOfString(plain(text), { width: W - gap, lineGap: 1.5 }) + 2);
  const y = doc.y;
  doc.text('•', MARGIN, y);
  parts.forEach((run, i) => {
    doc.font(run.bold ? 'Helvetica-Bold' : 'Helvetica');
    const opts = { width: W - gap, lineGap: 1.5, continued: i < parts.length - 1 };
    if (i === 0) doc.text(run.text, MARGIN + gap, y, opts);
    else doc.text(run.text, opts);
  });
  doc.moveDown(0.25);
}

/** Highlight bullet: marked runs print bold; with none marked, the thesis up to the first ": " does. */
function highlight(text) {
  if (!text.includes('**')) {
    const i = text.indexOf(': ');
    if (i >= 0) text = `**${text.slice(0, i + 2)}**${text.slice(i + 2)}`;
  }
  bullet(text);
}

/* ---- header: name, role, one contact line ---- */
doc.font('Helvetica-Bold').fontSize(20).text(profile.name, MARGIN, MARGIN, { width: W });
doc.moveDown(0.15);
doc.font('Helvetica').fontSize(11.5).text(resume.role ?? profile.role, { width: W });
doc.moveDown(0.35);
const linkedIn = (profile.links ?? []).find((l) => l.label === 'LinkedIn')?.url ?? '';
const gitHub = (profile.links ?? []).find((l) => l.label === 'GitHub')?.url ?? '';
const contact = [
  profile.contact,
  resume.website.replace(/^https?:\/\//, ''),
  linkedIn.replace(/^https?:\/\//, ''),
  gitHub.replace(/^https?:\/\//, ''),
  resume.location,
].filter(Boolean).join('  |  ');
doc.fontSize(9.5).text(contact, { width: W, lineGap: 1.5 });

/* ---- summary ---- */
heading('Summary');
doc.font('Helvetica').fontSize(10).text(resume.summary, { width: W, lineGap: 1.5 });

/* ---- selected accomplishments (above the fold, before the first role) ---- */
if (Array.isArray(resume.highlights) && resume.highlights.length) {
  heading('Career Highlights');
  for (const h of resume.highlights) highlight(h);
}

/* ---- experience: current roles in full, older ones under their own heading ---- */
/** Approximate height of a whole role block, so a keepTogether role moves to the next page intact. */
function roleHeight(job) {
  doc.font('Helvetica').fontSize(10);
  const body = job.bullets.reduce(
    (h, b) => h + doc.heightOfString(plain(b), { width: W - 13, lineGap: 1.5 }) + doc.currentLineHeight(true) * 0.25,
    0,
  );
  return 40 + body;
}
function roles(jobs) {
  jobs.forEach((job, i) => {
    if (i > 0) doc.moveDown(0.55);
    ensure(job.keepTogether ? roleHeight(job) : 48);
    doc.font('Helvetica-Bold').fontSize(10.5).text(`${job.title}, ${job.company}`, MARGIN, doc.y, { width: W });
    const meta = [`${job.start} – ${job.end}`, job.type, job.location].filter(Boolean).join('  |  ');
    doc.font('Helvetica').fontSize(9.5).fillColor('#333').text(meta, { width: W });
    doc.fillColor('#000').moveDown(0.2);
    for (const b of job.bullets) bullet(b);
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
  doc.font('Helvetica-Bold').fontSize(10.5).text(ed.degree, MARGIN, doc.y, { width: W });
  doc.font('Helvetica').fontSize(10).text(`${ed.degreeNative} — ${ed.school}, ${ed.location}`, { width: W, lineGap: 1.5 });
  if (ed.detail) doc.fontSize(9.5).fillColor('#333').text(ed.detail, { width: W, lineGap: 1.5 });
  doc.fillColor('#000');
}

/* ---- skills ---- */
heading('Skills');
for (const s of resume.skills) {
  const line = `${s.group}: `;
  doc.font('Helvetica-Bold').fontSize(10);
  ensure(doc.heightOfString(line + s.items, { width: W, lineGap: 1.5 }) + 2);
  doc.text(line, MARGIN, doc.y, { width: W, continued: true });
  doc.font('Helvetica').text(s.items, { width: W, lineGap: 1.5 });
  doc.moveDown(0.15);
}

/* ---- languages ---- */
heading('Languages');
doc.font('Helvetica').fontSize(10).text(resume.languages, MARGIN, doc.y, { width: W, lineGap: 1.5 });

doc.end();
console.log(`resume.pdf written to ${outPath}`);
