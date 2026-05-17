FROM node:20-slim

# System dependencies for visual document processing:
#   libreoffice    → PPTX → PDF conversion (headless)
#   poppler-utils  → pdftoppm: PDF → JPEG images per page
#   fonts-*        → prevent LibreOffice rendering glitches on headless environments
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    poppler-utils \
    fonts-liberation \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev
COPY backend/ ./backend/
COPY ui/ ./ui/
COPY db/ ./db/

# Ensure uploads directory exists at startup
RUN mkdir -p /app/uploads

WORKDIR /app/backend
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
