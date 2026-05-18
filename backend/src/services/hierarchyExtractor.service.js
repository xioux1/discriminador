const SLIDE_BREADCRUMB_MIN_REPEAT = 3;

export function detectGlobalNoise(pages) {
  const lineFrequency = new Map();

  for (const page of pages) {
    const uniqueInPage = new Set(
      page.lines.map((l) => l.text.trim()).filter((t) => t.length > 0)
    );
    for (const line of uniqueInPage) {
      lineFrequency.set(line, (lineFrequency.get(line) || 0) + 1);
    }
  }

  const noiseSet = new Set();
  for (const [line, count] of lineFrequency.entries()) {
    if (count >= SLIDE_BREADCRUMB_MIN_REPEAT) noiseSet.add(line);
  }
  return noiseSet;
}

export function detectDocumentMode(pages) {
  const totalTokens = pages.reduce(
    (sum, p) => sum + p.lines.reduce((acc, l) => acc + l.text.trim().split(/\s+/).filter(Boolean).length, 0),
    0
  );
  const avgTokensPerPage = totalTokens / Math.max(pages.length, 1);

  const pageNumberPattern = /^©?\s*\d{1,3}$/;
  const pagesWithPageNum = pages.filter((p) =>
    p.lines.some((l) => pageNumberPattern.test(l.text.trim()))
  ).length;

  const allLines = pages.flatMap((p) => p.lines);
  const shortLineRatio =
    allLines.filter((l) => {
      const words = l.text.trim().split(/\s+/).filter(Boolean);
      return words.length > 0 && words.length <= 8;
    }).length / Math.max(allLines.length, 1);

  const isSlide =
    avgTokensPerPage < 200 ||
    pagesWithPageNum / Math.max(pages.length, 1) > 0.5 ||
    shortLineRatio > 0.55;

  return isSlide ? 'SLIDE_PDF' : 'DENSE_PDF';
}

export function updatePath(currentPath, headingText, level) {
  const newPath = currentPath.slice(0, Math.max(level - 1, 0));
  newPath.push(headingText);
  return newPath;
}

export function parseSlideStructure(pages, noiseSet) {
  const pageNumberPattern = /^©?\s*\d{1,3}$/;
  const h2Signals = [
    /^el resultado[:\s]*$/i,
    /^aspectos importantes[:\s]*$/i,
    /^herramientas que puede proporcionar/i,
    /^algunas de las/i,
    /^fuente:/i,
  ];

  const sections = [];
  for (const page of pages) {
    const cleanLines = page.lines
      .map((l) => l.text.trim())
      .filter((l) => l.length > 0)
      .filter((l) => !noiseSet.has(l))
      .filter((l) => !pageNumberPattern.test(l));

    if (!cleanLines.length) continue;

    let h1 = null;
    const subsections = [];
    let currentH2 = null;
    let currentBody = [];

    for (const line of cleanLines) {
      if (h1 === null) {
        h1 = line;
        continue;
      }
      const isH2 =
        h2Signals.some((re) => re.test(line)) ||
        (line.endsWith(':') && line.split(/\s+/).length <= 6) ||
        (line.split(/\s+/).length <= 5 && !line.endsWith('.') && !/^[•\-]/.test(line));

      if (isH2) {
        if (currentH2 !== null || currentBody.length > 0) {
          subsections.push({ heading: currentH2, body: currentBody });
        }
        currentH2 = line;
        currentBody = [];
      } else {
        currentBody.push(line);
      }
    }

    subsections.push({ heading: currentH2, body: currentBody });
    sections.push({ pageNumber: page.pageNumber, h1, subsections });
  }

  return sections;
}

export function parseDenseStructure(pages, noiseSet) {
  const numberedHeading =
    /^(capítulo|capitulo|tema|unidad|parte|sección|seccion|módulo|modulo)?\s*(\d+(?:\.\d+)*)[.\s\-–—]+(.+)/i;
  const pureNumbered = /^(\d+(?:\.\d+)*)[.\s\-–—]+\S/;

  const allLines = pages.flatMap((p) =>
    p.lines
      .map((l, i) => ({ text: l.text.trim(), page: p.pageNumber, lineIdx: i }))
      .filter((l) => l.text.length > 0 && !noiseSet.has(l.text))
  );

  const classified = allLines.map((line) => {
    const { text } = line;
    let headingLevel = null;
    let headingText = text;

    const numMatch = text.match(numberedHeading) || text.match(pureNumbered);
    if (numMatch) {
      const numPart = numMatch[2] || numMatch[1] || '';
      headingLevel = numPart.split('.').filter(Boolean).length;
      headingText = text;
    } else if (text.length > 3 && text.length < 120) {
      const letters = text.replace(/[^a-záéíóúüñA-ZÁÉÍÓÚÜÑ]/g, '');
      const upperRatio =
        letters.length > 0
          ? [...letters].filter((c) => c === c.toUpperCase()).length / letters.length
          : 0;
      if (upperRatio > 0.65) headingLevel = 1;
    } else if (
      text.split(/\s+/).length <= 7 &&
      !text.endsWith('.') &&
      !/^[•\-*]/.test(text) &&
      text.length > 4
    ) {
      headingLevel = 2;
    }

    return { ...line, headingLevel, headingText };
  });

  const sections = [];
  let currentPath = [];
  let currentBody = [];
  let sectionStart = 0;

  const flush = (endIdx) => {
    if (currentPath.length > 0 || currentBody.length > 0) {
      sections.push({
        structural_path: [...currentPath],
        depth: currentPath.length,
        body: currentBody.join('\n'),
        startLine: sectionStart,
        endLine: endIdx,
      });
    }
  };

  for (let i = 0; i < classified.length; i++) {
    const item = classified[i];
    if (item.headingLevel !== null) {
      flush(i - 1);
      currentPath = updatePath(currentPath, item.headingText, item.headingLevel);
      currentBody = [];
      sectionStart = i;
    } else {
      currentBody.push(item.text);
    }
  }
  flush(classified.length - 1);
  return sections;
}

export function sectionsToChunks(sections, mode, docTitle) {
  const chunks = [];
  let chunkIndex = 0;

  if (mode === 'SLIDE_PDF') {
    for (const section of sections) {
      for (const sub of section.subsections) {
        const bodyText = sub.body.join('\n').trim();
        if (!bodyText && !sub.heading) continue;

        const path = [docTitle, section.h1, sub.heading].filter(Boolean);
        chunks.push({
          chunk_index: chunkIndex,
          text: bodyText || sub.heading,
          structural_path: path,
          depth: Math.max(path.length - 1, 0),
          page_start: section.pageNumber,
          page_end: section.pageNumber,
          position_in_doc: chunkIndex,
        });
        chunkIndex += 1;
      }
    }
  } else {
    for (const section of sections) {
      if (!section.body.trim()) continue;
      const path = section.structural_path.length ? section.structural_path : [docTitle];
      chunks.push({
        chunk_index: chunkIndex,
        text: section.body.trim(),
        structural_path: path,
        depth: section.depth,
        page_start: null,
        page_end: null,
        position_in_doc: chunkIndex,
      });
      chunkIndex += 1;
    }
  }

  return chunks;
}

export function extractHierarchy(rawText, { docTitle = 'Documento', forceMode = null } = {}) {
  const pageTexts = String(rawText || '').split('\f');
  const pages = pageTexts.map((text, i) => ({
    pageNumber: i + 1,
    lines: text
      .split('\n')
      .map((line) => ({ text: line }))
      .filter((l) => l.text.trim().length > 0),
  }));

  const noiseSet = detectGlobalNoise(pages);
  const mode = forceMode || detectDocumentMode(pages);
  const sections = mode === 'SLIDE_PDF' ? parseSlideStructure(pages, noiseSet) : parseDenseStructure(pages, noiseSet);
  const chunks = sectionsToChunks(sections, mode, docTitle);

  return { mode, chunks, noiseSet: [...noiseSet] };
}
