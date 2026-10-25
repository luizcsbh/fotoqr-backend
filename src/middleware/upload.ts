import multer from 'multer';
import { env } from '../config/env.js';

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
];

const storage = multer.memoryStorage();

const fileFilter = (
  _req: any,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const mime = file.mimetype.toLowerCase();
  const ext = file.originalname.split('.').pop()?.toLowerCase();

  const isAllowedMime = ALLOWED_MIME_TYPES.includes(mime);
  const isAllowedExt = ext ? ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif'].includes(ext) : false;

  if (isAllowedMime || isAllowedExt) {
    cb(null, true);
  } else {
    cb(
      new Error(
        'Formato de arquivo inválido. Apenas imagens (JPEG, PNG, WEBP, HEIC) são permitidas.'
      )
    );
  }
};

export const uploadMiddleware = multer({
  storage,
  limits: {
    fileSize: env.MAX_FILE_SIZE_MB * 1024 * 1024,
    files: env.MAX_FILES_PER_UPLOAD,
  },
  fileFilter,
});

export default uploadMiddleware;
