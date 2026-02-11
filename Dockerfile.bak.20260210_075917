# Full PDFRealm runtime with all engines
# - Node 20
# - LibreOffice (Word <-> PDF)
# - Ghostscript (compress)
# - ImageMagick + poppler (PDF <-> JPG, image ops)
# - qpdf (extra PDF merge/split if needed)
FROM node:20-slim

# Environment
ENV NODE_ENV=production
ENV PORT=8080

# App directory
WORKDIR /app

# ----------------------------------------------------
# System packages for all PDF engines
# ----------------------------------------------------
RUN apt-get update && \
    apt-get install -y \
      libreoffice \
      ghostscript \
      imagemagick \
      poppler-utils \
      qpdf \
      fonts-dejavu \
      fonts-liberation \
      libcairo2 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Allow ImageMagick to read/write PDFs (needed for PDF -> JPG)
# If the file isn't there (different IM version), this command just no-ops.
RUN sed -i 's/rights="none" pattern="PDF"/rights="read|write" pattern="PDF"/' /etc/ImageMagick-6/policy.xml || true

# ----------------------------------------------------
# Install Node dependencies
# ----------------------------------------------------
# Copy package files first so `npm install` is cached when possible
COPY package*.json ./

# Install only production deps (dev deps omitted)
RUN npm install --omit=dev

# Copy the rest of the app (public/, server.js, etc.)
COPY . .

# ----------------------------------------------------
# Network
# ----------------------------------------------------
EXPOSE 8080

# ----------------------------------------------------
# Start server
# ----------------------------------------------------
CMD ["node", "server.js"]


