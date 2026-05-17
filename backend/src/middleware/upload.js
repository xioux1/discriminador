import multer from 'multer';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

export const UPLOAD_DIR  = process.env.UPLOAD_DIR       || path.join(process.cwd(), 'uploads');
export const MAX_SLIDES  = Number(process.env.VISUAL_MAX_SLIDES || 60);
const MAX_FILE_MB        = Number(process.env.UPLOAD_MAX_FILE_MB || 100);

// MIME types and their canonical extensions.
// We cross-check both MIME and file extension to avoid spoofing.
export const ALLOWED_TYPES = new Map([
  ['application/pdf',                                                                          '.pdf'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation',               '.pptx'],
  // Some clients send this legacy MIME for PPTX:
  ['application/vnd.ms-powerpoint.presentation.macroEnabled.12',                              '.pptx'],
]);

// Returns the canonical extension for a given MIME type, or null if not allowed.
export function resolvedExtension(mimetype, originalname) {
  const ext = path.extname(originalname).toLowerCase();

  if (mimetype === 'application/pdf' && ext === '.pdf')  return '.pdf';
  if (
    (mimetype === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
     mimetype === 'application/vnd.ms-powerpoint.presentation.macroEnabled.12') &&
    ext === '.pptx'
  ) return '.pptx';

  return null;
}

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    const tmpDir = path.join(UPLOAD_DIR, 'tmp');
    try {
      await mkdir(tmpDir, { recursive: true });
      cb(null, tmpDir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // Timestamp + random hex to avoid collisions. No original name in path.
    const safe = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
    cb(null, safe);
  },
});

function fileFilter(_req, file, cb) {
  const ok = resolvedExtension(file.mimetype, file.originalname);
  if (ok) {
    cb(null, true);
  } else {
    cb(
      Object.assign(
        new Error(
          `Unsupported file type. Received MIME "${file.mimetype}" with extension ` +
          `"${path.extname(file.originalname)}". Only PDF (.pdf) and PowerPoint (.pptx) are accepted.`
        ),
        { code: 'UNSUPPORTED_FILE_TYPE', status: 415 }
      )
    );
  }
}

export const uploadMiddleware = multer({
  storage,
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024 },
  fileFilter,
}).single('file');
