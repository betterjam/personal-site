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

/** "•" with a hanging indent, page-break safe. */
function bullet(text) {
  const gap = 13;
  doc.font('Helvetica').fontSize(10);
  ensure(doc.heightOfString(text, { width: W - gap, lineGap: 1.5 }) + 2);
  const y = doc.y;
  doc.text('•', MARGIN, y);
  doc.text(text, MARGIN + gap, y, { width: W - gap, lineGap: 1.5 });
  doc.moveDown(0.25);
}

/* ---- header: name, role, one contact line ---- */
doc.font('Helvetica-Bold').fontSize(20).text(profile.name, MARGIN, MARGIN, { width: W });
doc.moveDown(0.15);
doc.font('Helvetica').fontSize(11.5).text(profile.role, { width: W });
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

/* ---- experience ---- */
heading('Professional Experience');
resume.experience.forEach((job, i) => {
  if (i > 0) doc.moveDown(0.55);
  ensure(48);
  doc.font('Helvetica-Bold').fontSize(10.5).text(`${job.title}, ${job.company}`, MARGIN, doc.y, { width: W });
  const meta = [`${job.start} – ${job.end}`, job.type, job.location].filter(Boolean).join('  |  ');
  doc.font('Helvetica').fontSize(9.5).fillColor('#333').text(meta, { width: W });
  doc.fillColor('#000').moveDown(0.2);
  for (const b of job.bullets) bullet(b);
});

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
